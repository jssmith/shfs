# Deployment pipeline

A build server in AWS with GitHub access makes signed, versioned releases; the
drive VM, which has no GitHub access and no long-lived secrets, deploys a given
release through one fixed SSM document. Design:
`design-agent-drive/docs/deployment-pipeline.md` (v0.2).

```
push to main ──▶ CodeBuild agent-drive-build (GitHub through CodeConnections)
                   buildspec.yml → deploy/aws/ci.sh install | test | package | publish
                   │ test (gVisor suites included), package release.tar.zst + manifest.json,
                   │ kms:Sign the manifest's digest → manifest.sig
                   ▼
                 s3://agent-drive-artifacts-<account>-<region>/releases/<sha>/  (put-if-absent)
                   │ ssm:SendCommand AgentDrive-Deploy Version=<sha>, tag agent-drive=dev
                   ▼
                 VM: deploy-release.sh (embedded in the document)
                   verify signature (KMS public key) → check sha256 → unpack to
                   /opt/agent-drive/releases/<sha> → setup.sh if provisioning changed →
                   current → releases/<sha> → restart agent-drive → /healthz → or roll back
```

## Files

| File | What |
| --- | --- |
| `pipeline.yaml` | Stack `agent-drive-pipeline`: connection, bucket, signing key, build project and role, SSM document |
| `dev-vm.yaml` | The VM stack; `ReleaseReadPolicy` lets its instance role read releases and the public key |
| `../../buildspec.yml` | CodeBuild's entry point; calls `ci.sh` |
| `ci.sh` | Build-side steps: install, test, package, publish (sign, upload, deploy, wait) |
| `deploy-release.sh` | VM-side deploy; embedded verbatim in the document |
| `sync-deploy-document.py` | Copies `deploy-release.sh` into `pipeline.yaml`; run it after changing the script |
| `test/test-deploy-release.sh` | Local test of publish and deploy with stub `aws`, `systemctl`, `curl` and a real P-256 key |
| `test/test-release-smoke.sh` | Packages this checkout, deploys it with stubs, and checks the real server's `/healthz` |
| `test/check-deploy-document.py` | The document takes only a sha, embeds the current script, and parses with `sh -n` |

## A release

`releases/<version>/`, version = the commit sha (`CODEBUILD_RESOLVED_SOURCE_VERSION`):

| Object | Contents |
| --- | --- |
| `release.tar.zst` | `package.json`, lockfile, `server/` and `cli/` (`dist`, `package.json`, data files from `src/`), production `node_modules`, `deploy/`, `sandbox/`, `RELEASE` |
| `manifest.json` | `format`, `version`, `build_id`, `build_arn`, `built_at`, `node_version`, `archive.{name,sha256,size}`, `setup_sha256`, `provision_sha256` |
| `manifest.sig` | ECDSA P-256 signature (DER) by KMS over the SHA-256 digest of `manifest.json` |

Each object is uploaded with `If-None-Match: *`, and the build role may only make
conditional puts, so a release is never overwritten. A rebuild of the same commit
fails at upload; redeploy an existing release with the document instead. The
manifest goes up last, so a manifest means a complete release.

`provision_sha256` covers what `setup.sh` installs from a release: `setup.sh`
itself, `deploy/aws/systemd/`, `deploy/cloudflare/` and `sandbox/`. The VM reruns
`setup.sh` only when it differs from the last one applied
(`/var/lib/agent-drive/deploy/provision.sha256`). Hashing `setup.sh` alone would
miss a changed unit file or sandbox image.

## On the VM

| Path | What |
| --- | --- |
| `/opt/agent-drive/releases/<sha>/` | Unpacked releases; the last 5 deployed are kept |
| `/opt/agent-drive/current` | Symlink to the running release; switched with an atomic rename |
| `/usr/local/sbin/agent-drive-deploy-release` | The deploy script, written by each run of the document |
| `/var/lib/agent-drive/deploy/` | `provision.sha256`, `previous`, `history`, `lock` |
| `/var/log/agent-drive-deploy.log` | Every deploy's log (SSM shows only the first 2,500 characters) |

`agent-drive.service` runs `/usr/local/bin/agent-drive serve` with
`WorkingDirectory=/opt/agent-drive/current`; the wrapper runs
`/opt/agent-drive/current/server/dist/main.js`. Node resolves the symlink, so a
running server keeps its own release's `node_modules`.

Store migrations: the server migrates `drive.db` when it starts, so the restart
is the migration. Nothing else is needed today. A rollback does not undo a
migration; a release whose migration an older release cannot read needs a
deliberate plan (the schema is in `server/src/store/schema.sql`).

The first deploy also runs `setup.sh` in full: packages, data volume, Node,
`runsc`, `cloudflared`, Ollama, the sandbox rootfs (Docker build) and the units.
Expect 15 to 25 minutes. The build waits up to 40 minutes
(`DEPLOY_WAIT_SECONDS`); if the build times out first, the deploy still finishes
on the VM. Check it with `get-command-invocation` or the log.

The document installs what the script needs before anything else: `zstd`, `jq`
(apt) and the AWS CLI v2 snap (`snap install aws-cli --classic`). The snap is
published by AWS and snapd checks its signature, and Ubuntu's EC2 images already
run snapd (the SSM agent is a snap). The alternative, AWS's zip with a GPG check,
needs AWS's signing key embedded in the document and kept current.

## Order of deployment (the lead, with admin credentials in the dev account)

All commands use `--region us-east-2`.

1. **Create the pipeline stack.** The VM stack must already exist: the key policy
   names its instance role.
   ```sh
   aws cloudformation deploy --region us-east-2 --stack-name agent-drive-pipeline \
     --template-file deploy/aws/pipeline.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides Webhook=false
   ```
2. **Johann completes the connection.** Console, us-east-2: Developer Tools >
   Settings > Connections > `agent-drive-github-personal` > *Update pending connection* >
   install the AWS Connector for GitHub app on `jssmith/agent-drive` only (*Only
   select repositories*) > *Connect*. Status becomes AVAILABLE.
   If the app is installed on more than one GitHub account or organisation, check
   that the installation number in the *GitHub Apps* box matches the one in
   github.com/settings/installations for the account that owns the repository.
   A connection bound to another installation is the suspected cause (not yet
   confirmed) of a connection that shows AVAILABLE while the webhook fails with
   "Repository not found or permission denied".
3. **Update the VM stack.** Make a change set and read it before running it:
   the only change should be **Add `ReleaseReadPolicy`**. The template resolves
   `ImageId` from Canonical's SSM parameter on every update, so if Canonical has
   published a newer AMI the change set will also show the launch template and
   **the instance being replaced**. Do not run that one; ask how to proceed (for
   example, attach the policy from outside the stack).
   ```sh
   aws cloudformation create-change-set --region us-east-2 --stack-name agent-drive-dev \
     --change-set-name a9-release-read --template-body file://deploy/aws/dev-vm.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=RunSetup,ParameterValue=false \
       ParameterKey=PipelineStackName,ParameterValue=agent-drive-pipeline \
       ParameterKey=InstanceType,UsePreviousValue=true \
       ParameterKey=NestedVirtualization,UsePreviousValue=true \
       ParameterKey=ImageId,UsePreviousValue=true \
       ParameterKey=RootVolumeSize,UsePreviousValue=true \
       ParameterKey=DataVolumeSize,UsePreviousValue=true \
       ParameterKey=VpcCidr,UsePreviousValue=true ParameterKey=SubnetCidr,UsePreviousValue=true \
       ParameterKey=RepoUrl,UsePreviousValue=true ParameterKey=RepoRef,UsePreviousValue=true \
       ParameterKey=PublicUrl,UsePreviousValue=true \
       ParameterKey=SnapshotRetainCount,UsePreviousValue=true
   aws cloudformation describe-change-set --region us-east-2 --stack-name agent-drive-dev \
     --change-set-name a9-release-read --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]'
   aws cloudformation execute-change-set --region us-east-2 --stack-name agent-drive-dev \
     --change-set-name a9-release-read
   ```
4. **Turn the webhook on** (needs the AVAILABLE connection):
   ```sh
   aws cloudformation deploy --region us-east-2 --stack-name agent-drive-pipeline \
     --template-file deploy/aws/pipeline.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides Webhook=true
   ```
5. **First build**, by hand (or push to `main`):
   ```sh
   aws codebuild start-build --region us-east-2 --project-name agent-drive-build \
     --environment-variables-override name=RELEASE,value=true,type=PLAINTEXT
   ```
   Follow it in CloudWatch Logs, group `/aws/codebuild/agent-drive-build`.
   If the gVisor suites cannot run in CodeBuild, add
   `name=GVISOR_TESTS,value=skip,type=PLAINTEXT` and report it.

   Choose **Install a new app** and install it on your **personal account** with *Only select repositories* → `agent-drive`. Do not pick an existing installation on an organization (an employer's, for example): the connection would point this AWS account at that organization, and a connection can't change installation once it is Available (it has to be replaced).

## Deploying or rolling back by hand

Any release still in the bucket can be deployed again, older ones included:

```sh
aws ssm send-command --region us-east-2 --document-name AgentDrive-Deploy \
  --targets Key=tag:agent-drive,Values=dev --parameters Version=<40-character sha> \
  --comment "roll back"
aws ssm list-command-invocations --region us-east-2 --command-id <id> --details \
  --query 'CommandInvocations[].[InstanceId,Status,CommandPlugins[0].Output]' --output text
```

The release is verified again and unpacked fresh (the running release is only
restarted). To list releases: `aws s3 ls s3://agent-drive-artifacts-277611628110-us-east-2/releases/`.
The `AgentDriveDev` permission set allows `ssm:SendCommand` with
`AWS-RunShellScript` only; to let that identity deploy, add
`arn:aws:ssm:*:*:document/AgentDrive-Deploy` to its `RunCommandDocument`
statement (and `codebuild:StartBuild`, `codebuild:BatchGetBuilds` and
`logs:GetLogEvents` on the project and its log group to start and follow builds).

## What each role can and cannot do

**Build role** `agent-drive-build-us-east-2` (assumable only by CodeBuild, for this project):

| Can | Resource |
| --- | --- |
| `codeconnections:UseConnection`, `GetConnection`, `GetConnectionToken` | the `agent-drive-github-personal` connection |
| `logs:CreateLogStream`, `logs:PutLogEvents` | log group `/aws/codebuild/agent-drive-build` |
| `s3:PutObject`, only with `If-None-Match` | `releases/*` in the artifact bucket |
| `s3:GetObject` | `releases/*` in the artifact bucket |
| `kms:Sign` (ECDSA_SHA_256), `kms:GetPublicKey`, `kms:Verify` | the release signing key |
| `ssm:SendCommand` | document `AgentDrive-Deploy`, on instances tagged `agent-drive=dev` |
| `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations` | `*` (no resource-level permissions exist) |

It cannot: overwrite or delete a release, list the bucket, read or write outside
`releases/`, run any other SSM document or any shell of its choosing on the VM,
reach untagged instances, change IAM, KMS or the stack.

**VM instance role** `agent-drive-dev-instance-us-east-2`:

| Can | Resource |
| --- | --- |
| `AmazonSSMManagedInstanceCore` (managed policy, unchanged) | Session Manager, Run Command agent |
| `s3:GetObject` | `releases/*` in the artifact bucket |
| `kms:GetPublicKey`, `kms:Verify` | the release signing key |

It cannot: sign, write to the bucket, list it, start builds, send commands,
reach GitHub with any credential (it holds none).

**Signing key** `alias/agent-drive-release-signing` (ECC_NIST_P256, SIGN_VERIFY):
account root administers it; an explicit Deny keeps every principal except the
build role from `kms:Sign`, administrators included. The private key never
leaves KMS.

**Bucket**: versioned, SSE-S3, all public access blocked, ACLs disabled, TLS-only
bucket policy, noncurrent versions expire after 90 days. SSE-S3 rather than
SSE-KMS: releases are built from a public repository and hold no secrets, the
signature provides integrity, and readers need no extra KMS permissions.

## Trust

Whoever can push to `main` can deploy to dev: that is the design. The VM accepts
only a manifest signed by the KMS key, for the version it was asked for (a
manifest copied from another version's path is refused), and only an archive
whose sha256 is in that manifest. A compromised bucket can withhold releases but
not change one. A compromised VM can read releases (public code) and verify
signatures, nothing more.

## Not covered yet

- ECR for the sandbox image: the VM builds its rootfs from `sandbox/` with
  Docker when provisioning changes. A rollback does not roll the rootfs back.
- The Rust `fs/` daemon is not built or shipped (not in use by the server).
- Production (`agent-drive=prod`, manual approval) and restricting the VM's
  outbound network.
