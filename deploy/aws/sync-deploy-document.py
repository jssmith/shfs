"""Embed deploy-release.sh in the AgentDrive-Deploy document of pipeline.yaml.

    python3 deploy/aws/sync-deploy-document.py          rewrite pipeline.yaml
    python3 deploy/aws/sync-deploy-document.py --check  fail if it is out of date

The document writes the script with a quoted heredoc, so nothing in it is
expanded; the only rules are that the script must not contain the heredoc's
end marker on a line of its own, nor `{{` (SSM would read it as a parameter).
"""
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
template = here / "pipeline.yaml"
script = (here / "deploy-release.sh").read_text()
MARK = "AGENT_DRIVE_DEPLOY_RELEASE"

if "{{" in script:
    sys.exit("deploy-release.sh contains '{{', which SSM would treat as a parameter")
if any(line.strip() == MARK for line in script.splitlines()):
    sys.exit(f"deploy-release.sh contains the heredoc marker {MARK}")
if "\t" in script:
    sys.exit("deploy-release.sh contains a tab; YAML block scalars do not allow tabs in indentation")

lines = template.read_text().splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if f"<<'{MARK}'" in l)
indent = lines[start][: len(lines[start]) - len(lines[start].lstrip())]
end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip("\n") == indent + MARK)
body = [(indent + l if l.strip() else "\n") for l in script.splitlines(keepends=True)]
new = lines[: start + 1] + body + lines[end:]

if "--check" in sys.argv:
    if new != lines:
        sys.exit("pipeline.yaml does not embed the current deploy-release.sh; run deploy/aws/sync-deploy-document.py")
    print("pipeline.yaml embeds the current deploy-release.sh")
else:
    template.write_text("".join(new))
    print(f"embedded deploy-release.sh ({len(body)} lines) in {template.name}")
