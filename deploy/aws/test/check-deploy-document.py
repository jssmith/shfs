"""Check the AgentDrive-Deploy document in pipeline.yaml.

    python3 deploy/aws/test/check-deploy-document.py

Renders the document's shell the way SSM and CloudFormation would (sample
values for the !Sub, a sample sha for {{ Version }}), then checks that
- the script it writes is byte-for-byte deploy/aws/deploy-release.sh,
- the whole command parses with sh -n (SSM runs it with /bin/sh) and the
  script with bash -n,
- Version is the only parameter and is pinned to a git sha.
"""
import pathlib
import re
import subprocess
import sys

from cfnlint.decode import decode

aws = pathlib.Path(__file__).resolve().parent.parent
template, errors = decode(str(aws / "pipeline.yaml"))
if errors:
    sys.exit(f"cannot parse template: {errors}")
doc = template["Resources"]["DeployDocument"]["Properties"]["Content"]

params = doc["parameters"]
assert list(params) == ["Version"], f"parameters: {list(params)}"
pattern = params["Version"]["allowedPattern"]
assert pattern == "^[0-9a-f]{40}$", pattern
for bad in ["main", "abc; rm -rf /", "$(id)", "0" * 39, "0" * 41, "A" * 40]:
    assert not re.fullmatch(pattern[1:-1], bad), bad

sample = {"ArtifactBucket": "agent-drive-artifacts-111122223333-us-east-2",
          "SigningKey.Arn": "arn:aws:kms:us-east-2:111122223333:key/0000",
          "AWS::Region": "us-east-2"}
lines = []
for step in doc["mainSteps"]:
    for c in step["inputs"]["runCommand"]:
        if isinstance(c, dict):
            c = c["Fn::Sub"]
            c = re.sub(r"\$\{([^}]+)\}", lambda m: sample[m.group(1)], c)
        lines.append(c)
command = "\n".join(lines).replace("{{ Version }}", "0123456789abcdef0123456789abcdef01234567")
assert "{{" not in command, "unexpected SSM parameter reference"

heredoc = re.search(r"<<'AGENT_DRIVE_DEPLOY_RELEASE'\n(.*?)^AGENT_DRIVE_DEPLOY_RELEASE$", command, re.S | re.M)
assert heredoc, "no embedded deploy-release.sh"
if heredoc.group(1) != (aws / "deploy-release.sh").read_text():
    sys.exit("embedded script differs from deploy-release.sh; run deploy/aws/sync-deploy-document.py")

subprocess.run(["sh", "-n"], input=command, text=True, check=True)
subprocess.run(["bash", "-n"], input=heredoc.group(1), text=True, check=True)
print("AgentDrive-Deploy: one parameter (git sha), embeds deploy-release.sh verbatim, parses with sh -n")
