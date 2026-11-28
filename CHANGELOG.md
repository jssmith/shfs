# Changelog

What changed for people running a drive. Versions follow
[Semantic Versioning](https://semver.org); the release process is in
[`docs/releasing.md`](docs/releasing.md).

## 0.1.0 (in preparation)

The first version that runs end to end on a drive VM. Development only, with
synthetic data.

- The thin drive: upload, the plain tree, labels, rings and the ring check
  (rules plus a local model), sessions over MCP with a shell (`bash`) in a
  gVisor sandbox, merge with undo per turn, held items for review.
- The sandbox image on Debian 13 (trixie), with Python, Node and common tools.
- Deployment: signed releases from version tags, deployed to a Debian 13 VM
  that verifies, switches and rolls back on its own.
