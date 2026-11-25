//! The same `DriveFs` served over the virtio-fs transport, without a VM: FUSE requests are
//! placed in guest memory behind a virtqueue descriptor chain, the way a guest kernel's
//! virtio-fs driver sends them, and answered by `Server::handle_message` with the virtio
//! `Reader` and `VirtioFsWriter`. A vhost-user-fs backend for a microVM is this loop plus the
//! vhost-user socket handling (vhost-user-backend crate).

use std::sync::Arc;

use agent_drive_fs::drivefs::{Config, DriveFs};
use agent_drive_fs::store;
use agent_drive_fs::stub::StubStore;
use fuse_backend_rs::abi::fuse_abi::{EntryOut, InHeader, InitIn, OpenIn, OpenOut, OutHeader, ReadIn};
use fuse_backend_rs::api::server::Server;
use fuse_backend_rs::transport::{Reader, VirtioFsWriter};
use virtio_queue::desc::{RawDescriptor, split::Descriptor as SplitDescriptor};
use virtio_queue::mock::MockSplitQueue;
use vm_memory::{ByteValued, Bytes, GuestAddress, GuestMemoryMmap};

const REQ: u64 = 0x10_0000;
const REPLY: u64 = 0x20_0000;
const REPLY_LEN: u32 = 0x2_0000;
const VRING_DESC_F_WRITE: u16 = 2;

const LOOKUP: u32 = 1;
const OPEN: u32 = 14;
const READ: u32 = 15;
const INIT: u32 = 26;

struct Guest {
    server: Server<Arc<DriveFs>>,
    unique: u64,
}

impl Guest {
    /// Sends one request through a descriptor chain; returns (error, reply body).
    fn call(&mut self, opcode: u32, nodeid: u64, body: &[u8]) -> (i32, Vec<u8>) {
        let mem: GuestMemoryMmap = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x40_0000)]).unwrap();
        self.unique += 1;
        let hdr = InHeader {
            len: (std::mem::size_of::<InHeader>() + body.len()) as u32,
            opcode,
            unique: self.unique,
            nodeid,
            ..Default::default()
        };
        let mut req = hdr.as_slice().to_vec();
        req.extend_from_slice(body);
        mem.write_slice(&req, GuestAddress(REQ)).unwrap();
        let vq = MockSplitQueue::new(&mem, 16);
        let descs = [
            RawDescriptor::from(SplitDescriptor::new(REQ, req.len() as u32, 0, 0)),
            RawDescriptor::from(SplitDescriptor::new(REPLY, REPLY_LEN, VRING_DESC_F_WRITE, 0)),
        ];
        let chain = vq.build_desc_chain(&descs).unwrap();
        let reader = Reader::from_descriptor_chain(&mem, chain.clone()).unwrap();
        let writer = VirtioFsWriter::new(&mem, chain).unwrap();
        self.server.handle_message(reader, writer.into(), None, None).unwrap();
        let out: OutHeader = mem.read_obj(GuestAddress(REPLY)).unwrap();
        assert_eq!(out.unique, self.unique);
        let n = out.len as usize - std::mem::size_of::<OutHeader>();
        let mut body = vec![0u8; n];
        mem.read_slice(&mut body, GuestAddress(REPLY + std::mem::size_of::<OutHeader>() as u64)).unwrap();
        (out.error, body)
    }

    fn lookup(&mut self, parent: u64, name: &str) -> Result<EntryOut, i32> {
        let mut b = name.as_bytes().to_vec();
        b.push(0);
        let (e, body) = self.call(LOOKUP, parent, &b);
        if e != 0 {
            return Err(-e);
        }
        Ok(*EntryOut::from_slice(&body[..std::mem::size_of::<EntryOut>()]).unwrap())
    }
}

#[test]
fn same_fs_over_virtio_queue() {
    let tmp = tempfile::Builder::new().prefix("a2-fs-virtio-").tempdir().unwrap();
    let data = tmp.path().join("data");
    let mut s = StubStore::create(&data, "a2-vq").unwrap();
    s.add_synthetic().unwrap();
    drop(s);
    let fs = DriveFs::new(Config::new(&data, "a2-vq")).unwrap();
    let fs = Arc::new(fs);
    let mut g = Guest { server: Server::new(fs.clone()), unique: 0 };

    let init = InitIn { major: 7, minor: 33, max_readahead: 0x2_0000, flags: 0 };
    let (e, _) = g.call(INIT, 0, init.as_slice());
    assert_eq!(e, 0);

    let notes = g.lookup(1, "notes").unwrap();
    let todo = g.lookup(notes.nodeid, "todo.txt").unwrap();
    assert_eq!(todo.attr.size, 21);
    assert_eq!(g.lookup(1, "finance").err(), Some(libc::ENOENT));

    let open = OpenIn { flags: libc::O_RDONLY as u32, fuse_flags: 0 };
    let (e, body) = g.call(OPEN, todo.nodeid, open.as_slice());
    assert_eq!(e, 0);
    let oo = *OpenOut::from_slice(&body[..std::mem::size_of::<OpenOut>()]).unwrap();
    let read = ReadIn { fh: oo.fh, offset: 0, size: 4096, ..Default::default() };
    let (e, body) = g.call(READ, todo.nodeid, read.as_slice());
    assert_eq!(e, 0);
    assert_eq!(body, b"buy milk\nwrite spike\n");

    // The open was accounted, and hiding applies on the next lookup, as over /dev/fuse.
    fs.flush_activity();
    let conn = store::open(&data).unwrap();
    let opens: i64 = conn.query_row("SELECT count(*) FROM activity WHERE op = 'open'", [], |r| r.get(0)).unwrap();
    assert_eq!(opens, 1);
    store::hide_path(&conn, "a2-vq", "notes/todo.txt").unwrap();
    assert_eq!(g.lookup(notes.nodeid, "todo.txt").err(), Some(libc::ENOENT));
}
