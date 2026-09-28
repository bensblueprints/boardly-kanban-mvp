const {utils}=require('ssh2');

function generateKey(){
 const pair=utils.generateKeyPairSync('ed25519');
 return {private_key:pair.private,public_key:pair.public.trim()+' boardly'};
}

// Only a server-generated public key enters these scripts. Hostnames, labels,
// usernames and private credentials are never interpolated into shell code.
function installCommands(publicKey){
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+ boardly$/.test(publicKey))throw Error('Invalid generated public key');
 const linux=`set -eu
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
grep -qxF '${publicKey}' "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' '${publicKey}' >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
printf '%s\\n' 'Boardly public key installed. Return to Boardly and check the connection.'
for boardly_host_key in /etc/ssh/ssh_host_*_key.pub; do
  [ ! -r "$boardly_host_key" ] || ssh-keygen -lf "$boardly_host_key"
done`;
 const windows=`$ErrorActionPreference = 'Stop'
$boardlyPublicKey = '${publicKey}'
$boardlyIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$boardlyAdmin = (New-Object Security.Principal.WindowsPrincipal($boardlyIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($boardlyAdmin) {
  $boardlyKeyFile = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
} else {
  $boardlyKeyFile = Join-Path $env:USERPROFILE '.ssh\\authorized_keys'
}
New-Item -ItemType Directory -Force -Path (Split-Path $boardlyKeyFile) | Out-Null
if (!(Test-Path $boardlyKeyFile)) { New-Item -ItemType File -Path $boardlyKeyFile | Out-Null }
if (!(Get-Content $boardlyKeyFile | Where-Object { $_ -eq $boardlyPublicKey })) { Add-Content -Encoding ascii -Path $boardlyKeyFile -Value ("\x60r\x60n" + $boardlyPublicKey) }
if ($boardlyAdmin) {
  icacls.exe $boardlyKeyFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
} else {
  icacls.exe $boardlyKeyFile /inheritance:r /grant:r ($boardlyIdentity.Name + ':F') '*S-1-5-18:F' | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw 'Could not set SSH key file permissions.' }
Write-Output 'Boardly public key installed. Return to Boardly and check the connection.'
Get-ChildItem "$env:ProgramData\\ssh\\ssh_host_*_key.pub" -ErrorAction SilentlyContinue | ForEach-Object { ssh-keygen -lf $_.FullName }`;
 return {linux,windows};
}
module.exports={generateKey,installCommands};
