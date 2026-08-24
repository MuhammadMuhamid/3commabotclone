#!/bin/bash
# Run inside AWS CloudShell (ap-southeast-2) — launches signal-bot EC2 + security group + elastic IP
set -euo pipefail
REGION=ap-southeast-2
NAME=signal-bot
KEY_NAME=tradingsignalbot

echo "==> Key pair"
# Only create when absent. The old form redirected into ${KEY_NAME}.pem before
# the command could fail, so a pre-existing key left a 0-byte .pem behind and
# the summary below told you to download it — that empty file would overwrite a
# good local key. AWS only ever returns the private key at creation time, so a
# key that already exists must be reused from the copy you already hold.
CREATED_KEY=false
if aws ec2 --region "$REGION" describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "    Key pair '$KEY_NAME' already exists — reusing it (keep using your local ${KEY_NAME}.pem)"
else
  aws ec2 --region "$REGION" create-key-pair --key-name "$KEY_NAME" --query 'KeyMaterial' --output text > "${KEY_NAME}.pem"
  chmod 400 "${KEY_NAME}.pem"
  CREATED_KEY=true
  echo "    Created new key pair '$KEY_NAME'"
fi

echo "==> Security group"
VPC_ID=$(aws ec2 --region "$REGION" describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 --region "$REGION" create-security-group \
  --group-name signal-bot-sg \
  --description "Signal bot HTTP HTTPS SSH" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text 2>/dev/null) || \
  SG_ID=$(aws ec2 --region "$REGION" describe-security-groups --filters Name=group-name,Values=signal-bot-sg --query 'SecurityGroups[0].GroupId' --output text)

MY_IP=$(curl -s https://checkip.amazonaws.com | tr -d '\n')
aws ec2 --region "$REGION" authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "${MY_IP}/32" 2>/dev/null || true
aws ec2 --region "$REGION" authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 2>/dev/null || true
aws ec2 --region "$REGION" authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 2>/dev/null || true

echo "==> Latest Ubuntu 22.04 AMI"
AMI=$(aws ec2 --region "$REGION" describe-images \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)

echo "==> Launch instance (t3.micro)"
INSTANCE_ID=$(aws ec2 --region "$REGION" run-instances \
  --image-id "$AMI" \
  --instance-type t3.micro \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 --region "$REGION" wait instance-running --instance-ids "$INSTANCE_ID"
PUBLIC_IP=$(aws ec2 --region "$REGION" describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo "==> Allocate Elastic IP"
ALLOC=$(aws ec2 --region "$REGION" allocate-address --domain vpc --query AllocationId --output text)
aws ec2 --region "$REGION" associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" >/dev/null
EIP=$(aws ec2 --region "$REGION" describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)

echo ""
echo "========================================"
echo "INSTANCE_ID=$INSTANCE_ID"
echo "ELASTIC_IP=$EIP"
echo "KEY_NAME=$KEY_NAME"
if [ "$CREATED_KEY" = true ]; then
  echo "Download ${KEY_NAME}.pem from this CloudShell session (Actions > Download file)"
else
  echo "Key pair reused — use the ${KEY_NAME}.pem you already have locally"
fi
echo "Hostinger DNS: A record bot -> $EIP"
echo "========================================"
