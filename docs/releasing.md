# Releasing

How a version of Agent Drive gets from `main` to a release, and to the drive
VM. The mechanics (roles, signing, the VM side) are in
[`deploy/aws/PIPELINE.md`](../deploy/aws/PIPELINE.md).

## Rules

- **`main` is always releasable.** It changes only through pull requests that
  pass CI (`test` and `rust`; the `main` ruleset enforces it).
- **A release is a tag.** A version tag on a commit of `main` releases that
  commit. Nothing else releases: not a push, not a merge, not a manual upload.
- **Versions follow [Semantic Versioning](https://semver.org).** Tags are
  `vMAJOR.MINOR.PATCH`. Before 1.0, a MINOR bump may break things; say so in
  the changelog. Pre-releases are `vX.Y.Z-dev.N` (for the dev VM) and
  `vX.Y.Z-rc.N` (release candidates).
- **Who releases:** Johann. The release job runs in the GitHub environment
  `release`, which waits for his approval; the AWS release role accepts only
  that environment's jobs. Agent sessions prepare releases (changelog, version
  bumps) in pull requests; they do not push tags.
- **Every release is signed and traceable:** its manifest names the commit, the
  tag and the workflow run, and is signed by a KMS key that only the release
  workflow can use.

## Steps

1. **Prepare** in a pull request:
   - `CHANGELOG.md`: a section for the version, with what changed for people
     running a drive (features, fixes, anything that breaks or needs action).
   - Versions: `package.json` (root, `server/`, `cli/`) and `fs/Cargo.toml`, all
     the same version.
   - Merge it once CI passes.
2. **Tag** the merge commit on `main` and push the tag:
   ```bash
   git switch main && git pull --ff-only
   ```
   ```bash
   git tag -a v0.1.0 -m "Agent Drive 0.1.0"
   ```
   ```bash
   git push origin v0.1.0
   ```
3. **The release workflow** (`.github/workflows/release.yml`) then:
   1. runs the full CI again on the tagged commit;
   2. waits for Johann's approval of the `release` environment (Actions > the
      run > *Review deployments*);
   3. checks that the tagged commit is on `main` (a guard against mistakes;
      the approval is the security boundary, because a tag runs the workflow
      as it is in the tagged commit);
   4. builds and packages the release (`deploy/aws/ci.sh package`);
   5. takes short-lived AWS credentials through GitHub's OIDC token (no stored
      keys), signs the manifest with KMS, and uploads
      `releases/<commit>/{release.tar.zst,manifest.json,manifest.sig}`; an
      existing release is never overwritten;
   6. deploys it to the dev VM through the `AgentDrive-Deploy` document and
      waits: the VM verifies the signature and checksum, switches, restarts and
      checks health, and rolls back by itself if any step fails.
4. **Check** the run on GitHub (Actions > release) and the drive's health
   (`/healthz`). The VM's log is `/var/log/agent-drive-deploy.log`.

## Rolling back

Deploy the previous release again; nothing is rebuilt:

```bash
aws ssm send-command --region us-east-2 --document-name AgentDrive-Deploy \
  --targets Key=tag:agent-drive,Values=dev --parameters Version=<previous commit sha>
```

The VM keeps its last five releases. A bad release stays in the bucket (it is
never overwritten); fix forward with a new version.

## What a release publishes

| Where | What | Status |
| --- | --- | --- |
| S3 `releases/<commit>/` | Signed server and CLI bundle, deployed to the dev VM | Built |
| GitHub release for the tag | Notes from `CHANGELOG.md`; the bundle, checksums and signature; `fs` daemon binaries (x86_64, arm64) | Planned |
| GitHub Container Registry | The sandbox image (`sandbox/`, Debian 13), by digest | Planned |
| npm | The `drive` CLI, once it is useful outside the drive VM | Planned |

Registries are published with trusted publishing from the release workflow
(short-lived tokens issued per run), not with stored tokens.

## Set up once

- **The `release` environment** (Settings > Environments > New environment,
  named `release`): *Required reviewers*: Johann; *Prevent self-review* off (he
  tags and approves); *Deployment branches and tags*: selected, tag rule `v*`.
  **Do this before the first tag:** GitHub creates a missing environment on
  first use with no protection rules, and the release role would accept its
  jobs. Only repository admins can change an environment's rules.
- **A ruleset on `v*` tags** (Settings > Rules > New tag ruleset): only Johann
  creates them (bypass list); tags cannot be updated or deleted.

## Before the first public release

- Production: its own VM tagged `agent-drive=prod`, deployed only from
  non-pre-release tags, after an approval in a GitHub environment.
- `CHANGELOG.md`, and a security policy page (`SECURITY.md`).
