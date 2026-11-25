"""Render the dev VM's user data with sample values and check it with `bash -n`.

    python3 deploy/aws/check-user-data.py deploy/aws/dev-vm.yaml
"""
import re
import subprocess
import sys

from cfnlint.decode import decode  # cfn-lint's loader understands !Sub and friends

template, errors = decode(sys.argv[1])
if errors:
    sys.exit(f"cannot parse template: {errors}")
sub = template["Resources"]["Instance"]["Properties"]["UserData"]["Fn::Base64"]["Fn::Sub"]
script = sub[0]
sample = {
    "DataVolume": "vol-0123456789abcdef0",
    "PublicUrl": "https://drive-dev.example.com",
    "RepoUrl": "https://github.com/jssmith/agent-drive.git",
    "RepoRef": "main",
    "RunSetup": "true",
}
unknown = set(re.findall(r"\$\{([A-Za-z0-9:]+)\}", script)) - set(sample)
if unknown:
    sys.exit(f"unresolved substitutions: {sorted(unknown)}")
rendered = re.sub(r"\$\{([A-Za-z0-9:]+)\}", lambda m: sample[m.group(1)], script)
subprocess.run(["bash", "-n"], input=rendered.encode(), check=True)
assert "DATA_VOLUME_ID=vol-0123456789abcdef0" in rendered
print(rendered)
print("user data: bash -n ok", file=sys.stderr)
