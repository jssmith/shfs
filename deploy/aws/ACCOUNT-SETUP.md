# AWS development account: one-time setup (Johann)

Goal: a separate AWS account that holds only the Agent Drive development VM, a
budget alert on it, and a dedicated sign-in identity that can manage EC2 and
run commands on the dev VM there, and nothing else. The build agent reaches AWS
only through that identity (the AWS MCP Server connector in claude.ai), so its
reach is the account and this permission set. Synthetic data only on this VM.

About an hour, most of it waiting for the account to be created. All steps are
in the console; CLI equivalents are given where they are short. Run the CLI
lines from the **management account** with an admin session, except where noted.

## 1. Create the member account

AWS Organizations → **Add an AWS account** → *Create an AWS account*.

| Field | Value |
| --- | --- |
| Account name | `agent-drive-dev` |
| Email | a new address or alias you control, e.g. `you+agent-drive-dev@…` |
| IAM role name | leave the default `OrganizationAccountAccessRole` |

```sh
aws organizations create-account --account-name agent-drive-dev \
  --email 'you+agent-drive-dev@example.com'
aws organizations list-create-account-status --states SUCCEEDED   # note the AccountId
```

Optional but recommended: move it to an organizational unit `Development` and
attach a service control policy that only allows the regions you use (e.g.
`us-east-1`), so a mistake cannot start instances elsewhere.

## 2. Budget alert

Billing and Cost Management → **Budgets** → *Create budget* → *Cost budget*,
in the management account (scoped to the member account) or in the member
account itself.

- Amount: monthly, e.g. **$400**. For scale: an m8i.2xlarge on demand is
  roughly $0.42 an hour, about $310 a month if never stopped; the 200 GB gp3
  volume about $16 a month; snapshots and transfer a few dollars. Check current
  prices for your region. Stopping the VM when idle cuts most of it.
- Filter: *Linked account* = `agent-drive-dev` (when created in the management account).
- Alerts to your email: actual 50 %, actual 80 %, actual 100 %, forecasted 100 %.

```sh
DEV=<dev account id>; ME=<your account id>   # the management account
cat > /tmp/budget.json <<EOF
{ "BudgetName": "agent-drive-dev", "BudgetType": "COST", "TimeUnit": "MONTHLY",
  "BudgetLimit": { "Amount": "400", "Unit": "USD" },
  "CostFilters": { "LinkedAccount": ["$DEV"] } }
EOF
cat > /tmp/notify.json <<'EOF'
[ {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":50,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]},
  {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]},
  {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]},
  {"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
   "Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]} ]
EOF
aws budgets create-budget --account-id "$ME" --budget file:///tmp/budget.json \
  --notifications-with-subscribers file:///tmp/notify.json
```

## 3. IAM Identity Center user

IAM Identity Center (enable it in the management account if it is not yet) →
**Users** → *Add user*:

| Field | Value |
| --- | --- |
| Username | `agent-drive-dev` |
| Email | an address you read (the invitation goes there) |
| Groups | none |

Accept the invitation, set a password and **register an MFA device**. This is
the identity you sign in with when connecting the AWS MCP Server in claude.ai;
it is not your own administrator user.

## 4. Permission set limited to the dev account

IAM Identity Center → **Permission sets** → *Create permission set* → *Custom*:

- Name `AgentDriveDev`, session duration 4 hours.
- AWS managed policy: **`AmazonEC2FullAccess`**.
- Inline policy: the contents of [`permission-set-policy.json`](permission-set-policy.json)
  (reproduced below).

Then **AWS accounts** → select `agent-drive-dev` only → *Assign users or
groups* → user `agent-drive-dev` → permission set `AgentDriveDev`. Do not
assign it to any other account: the account assignment is what limits it to
the development account.

```sh
SSO=$(aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text)
IDS=$(aws sso-admin list-instances --query 'Instances[0].IdentityStoreId' --output text)
PS=$(aws sso-admin create-permission-set --instance-arn "$SSO" --name AgentDriveDev \
      --session-duration PT4H --query PermissionSet.PermissionSetArn --output text)
aws sso-admin attach-managed-policy-to-permission-set --instance-arn "$SSO" --permission-set-arn "$PS" \
  --managed-policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess
aws sso-admin put-inline-policy-to-permission-set --instance-arn "$SSO" --permission-set-arn "$PS" \
  --inline-policy file://deploy/aws/permission-set-policy.json
USER=$(aws identitystore list-users --identity-store-id "$IDS" \
  --filters AttributePath=UserName,AttributeValue=agent-drive-dev --query 'Users[0].UserId' --output text)
aws sso-admin create-account-assignment --instance-arn "$SSO" --permission-set-arn "$PS" \
  --target-type AWS_ACCOUNT --target-id "$DEV" --principal-type USER --principal-id "$USER"
```

What the permission set allows and refuses:

| | Allowed | Refused |
| --- | --- | --- |
| EC2 | Everything in `AmazonEC2FullAccess` (instances, volumes, snapshots, VPCs, security groups) in this account | Reserved instances, capacity reservations, dedicated hosts; moving or removing the `agent-drive` tag on an existing instance |
| Systems Manager | `ssm:SendCommand` with `AWS-RunShellScript`, **only on instances tagged `agent-drive=dev`**; reading command status and output; listing managed instances | Commands on any other instance; other documents; Session Manager (see below) |
| IAM | Reading; passing the instance role `agent-drive-dev-instance-*` to EC2 (to relaunch the VM) | Creating, changing or deleting users, roles, policies; Identity Center; Organizations; assuming roles |
| Billing | — | Everything under billing, payments, Cost Explorer, budgets, Savings Plans |
| CloudFormation | Reading the `agent-drive-dev` stack | Creating or changing stacks (the stack creates IAM roles, so you deploy it, step 6) |

Notes:

- The read calls for Run Command (`GetCommandInvocation`, `ListCommands`, …)
  do not support resource-level permissions in IAM, so they are allowed on
  `*`. In an account that holds only the dev VM this reveals nothing else.
- `AmazonEC2FullAccess` lets the identity create new instances and tag them
  `agent-drive=dev` at launch, which then accepts commands. That is the point
  (it can rebuild the VM) and stays inside this account.
- To also give the identity an interactive shell through Session Manager, add
  a statement allowing `ssm:StartSession` on `arn:aws:ec2:*:*:instance/*` with
  the same `ssm:resourceTag/agent-drive` condition, plus
  `arn:aws:ssm:*:*:document/SSM-SessionManagerRunShell`, and
  `ssm:TerminateSession`/`ssm:ResumeSession` on
  `arn:aws:ssm:*:*:session/${aws:userid}-*`. Not needed for the AWS MCP Server.

## 5. Account defaults (in the dev account)

Sign in to the dev account as an administrator (management account → *Switch
role* to `OrganizationAccountAccessRole` in the dev account), then, in the
region you use:

```sh
aws ec2 enable-ebs-encryption-by-default --region us-east-1
aws ec2 get-ebs-encryption-by-default --region us-east-1
```

The template encrypts its volumes anyway; this covers anything made by hand.

## 6. Deploy the VM

Still as administrator in the dev account (the stack creates the instance role,
which the `AgentDriveDev` identity may not):

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name agent-drive-dev \
  --template-file deploy/aws/dev-vm.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags agent-drive=dev \
  --parameter-overrides RepoRef=main
aws cloudformation describe-stacks --stack-name agent-drive-dev --region us-east-1 \
  --query 'Stacks[0].Outputs'
```

First boot runs `deploy/aws/setup.sh` (about 10 to 15 minutes; log at
`/var/log/agent-drive-setup.log`). Nested virtualization (gVisor's KVM
platform) needs a C8i, M8i or R8i instance in a region that offers it; if the
stack fails on `CpuOptions`, deploy with `NestedVirtualization=disabled` and
gVisor uses systrap.

Then the tunnel: [`deploy/cloudflare/README.md`](../cloudflare/README.md).

## 7. Connect the AWS MCP Server in claude.ai

Add the AWS MCP Server as a connector and sign in through AWS Sign-In with the
Identity Center user `agent-drive-dev` (account `agent-drive-dev`, permission
set `AgentDriveDev`). Check with a harmless call, e.g. asking it to describe
instances tagged `agent-drive=dev` and to run `uptime` on the VM through
`ssm send-command`.

## Permission set inline policy

The same as [`permission-set-policy.json`](permission-set-policy.json):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RunCommandOnDevInstancesOnly",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringEquals": { "ssm:resourceTag/agent-drive": "dev" } }
    },
    {
      "Sid": "RunCommandDocument",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ssm:*:*:document/AWS-RunShellScript"
    },
    {
      "Sid": "RunCommandReads",
      "Effect": "Allow",
      "Action": [
        "ssm:CancelCommand",
        "ssm:ListCommands",
        "ssm:ListCommandInvocations",
        "ssm:GetCommandInvocation",
        "ssm:DescribeInstanceInformation",
        "ssm:DescribeInstanceProperties",
        "ssm:GetConnectionStatus",
        "ssm:ListDocuments",
        "ssm:DescribeDocument"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadUbuntuImageParameters",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:*:*:parameter/aws/service/canonical/*"
    },
    {
      "Sid": "LaunchWithTheDevInstanceRoleOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/agent-drive-dev-instance-*",
      "Condition": { "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" } }
    },
    {
      "Sid": "ReadStackStatus",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate"
      ],
      "Resource": "arn:aws:cloudformation:*:*:stack/agent-drive-dev/*"
    },
    {
      "Sid": "NoIamAdministration",
      "Effect": "Deny",
      "NotAction": [
        "iam:PassRole",
        "iam:Get*",
        "iam:List*",
        "iam:CreateServiceLinkedRole"
      ],
      "Resource": "arn:aws:iam::*:*"
    },
    {
      "Sid": "NoIdentityOrAccountAdministration",
      "Effect": "Deny",
      "Action": [
        "sso:*",
        "sso-directory:*",
        "identitystore:*",
        "organizations:*",
        "account:*",
        "sts:AssumeRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoBilling",
      "Effect": "Deny",
      "Action": [
        "aws-portal:*",
        "billing:*",
        "payments:*",
        "tax:*",
        "invoicing:*",
        "purchase-orders:*",
        "ce:*",
        "cur:*",
        "budgets:*",
        "freetier:*",
        "consolidatedbilling:*",
        "savingsplans:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoLongTermCommitments",
      "Effect": "Deny",
      "Action": [
        "ec2:PurchaseReservedInstancesOffering",
        "ec2:AcceptReservedInstancesExchangeQuote",
        "ec2:PurchaseHostReservation",
        "ec2:PurchaseScheduledInstances",
        "ec2:PurchaseCapacityBlock",
        "ec2:CreateCapacityReservation",
        "ec2:AllocateHosts"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoMovingTheDevTagOntoOtherInstances",
      "Effect": "Deny",
      "Action": "ec2:CreateTags",
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": {
        "ForAnyValue:StringEquals": { "aws:TagKeys": ["agent-drive"] },
        "StringNotEquals": { "ec2:CreateAction": "RunInstances" }
      }
    },
    {
      "Sid": "NoRemovingTheDevTag",
      "Effect": "Deny",
      "Action": "ec2:DeleteTags",
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "ForAnyValue:StringEquals": { "aws:TagKeys": ["agent-drive"] } }
    }
  ]
}
```
