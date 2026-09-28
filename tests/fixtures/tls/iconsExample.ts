/**
 * Self-signed TLS identity for the loopback HTTPS harness used by network
 * tests. Test-only material: never trusted outside a test that passes `cert`
 * as its `ca`. Regenerate with:
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
 *     -keyout key.pem -out cert.pem -days 36500 -subj "/CN=icons.example" \
 *     -addext "subjectAltName=DNS:icons.example" \
 *     -addext "basicConstraints=critical,CA:TRUE" \
 *     -addext "keyUsage=critical,digitalSignature,keyCertSign"
 */
export const ICONS_EXAMPLE_HOSTNAME = "icons.example";

export const ICONS_EXAMPLE_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3cgP40dShl8CgzgX
DRrIeNL4qc1xuEp9H59jQC4KAWahRANCAARaZ1oLq//ANJFEzo00DishI+a3MZGm
N5g5fO7PY/KCO8UsnBAamHEzMby8jpDMzn/9+KEKjYfmNiUbBDA5eofa
-----END PRIVATE KEY-----
`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBsTCCAVegAwIBAgIUViGW86Ua9WqAa3QC6BYzHt7Zok8wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNaWNvbnMuZXhhbXBsZTAgFw0yNjA5MTYxODI5MjRaGA8yMTI2
MDgyMzE4MjkyNFowGDEWMBQGA1UEAwwNaWNvbnMuZXhhbXBsZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFpnWgur/8A0kUTOjTQOKyEj5rcxkaY3mDl87s9j8oI7
xSycEBqYcTMxvLyOkMzOf/34oQqNh+Y2JRsEMDl6h9qjfTB7MB0GA1UdDgQWBBQE
o9U0VSJBCKz1k2G6JRgfANDEXDAfBgNVHSMEGDAWgBQEo9U0VSJBCKz1k2G6JRgf
ANDEXDAYBgNVHREEETAPgg1pY29ucy5leGFtcGxlMA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgKEMAoGCCqGSM49BAMCA0gAMEUCIDRKQ9GiOANvLs+v5MaP
VH+fcLCLivWPSRrdEzCpxjocAiEAj4SqYMWVqH4iN/cay+t622HKe6AveWIJWSDk
7fPVfFU=
-----END CERTIFICATE-----
`,
};
