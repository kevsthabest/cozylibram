# Cozy Libram over LAN with HTTPS (mkcert)

The barcode scanner needs the camera, and browsers only grant camera access on
**secure contexts** — `https://` or `http://localhost`. If you serve the app
from your home server over plain `http://192.168.x.x`, the camera is blocked.
This guide sets up trusted HTTPS on your LAN with
[mkcert](https://github.com/FiloSottile/mkcert), a tool that creates a local
certificate authority (CA) your devices trust.

No changes to the app are needed — it already requests the camera the
standard way; it just needs a secure origin.

## 1. Install mkcert (on the server)

**Windows (the usual home-server setup):**

```powershell
choco install mkcert
# or: winget install FiloSottile.mkcert
mkcert -install
```

**macOS / Linux:** see the mkcert README (`brew install mkcert`, `apt install
mkcert`, …), then run `mkcert -install`.

`mkcert -install` creates a local CA and registers it in the system trust
store (and Firefox's, if present).

## 2. Issue a certificate for the server's LAN address

Find the server's LAN IP (e.g. `192.168.1.50`), then from the folder where you
run the server:

```powershell
mkcert 192.168.1.50 localhost 127.0.0.1
```

This writes two files, e.g. `192.168.1.50.pem` (cert) and
`192.168.1.50-key.pem` (key).

## 3. Serve the app over HTTPS

The repo's `server.py` is plain HTTP. The simplest path is a tiny HTTPS
wrapper — for example with Python:

```powershell
# serve-https.py (run next to server.py)
```

```python
import http.server, ssl
srv = http.server.HTTPServer(('0.0.0.0', 8443),
      http.server.SimpleHTTPRequestHandler)
srv.socket = ssl.wrap_socket(srv.socket, server_side=True,
    certfile='192.168.1.50.pem', keyfile='192.168.1.50-key.pem')
print('Serving HTTPS on :8443')
srv.serve_forever()
```

(If `server.py`'s `/config.js` secrets endpoint matters to you, put the HTTPS
listener in front of it instead — the point is the *browser* must load the
page over `https://`.)

## 4. Trust the CA on the phone

The phone must trust your mkcert CA, or it will show a certificate warning
(and the camera stays blocked until you accept it):

1. On the server: `mkcert -CAROOT`, then copy `rootCA.pem` to the phone
   (email it to yourself, or host it on the LAN).
2. **Android:** Settings → Security → Encryption & credentials → Install a
   certificate → CA certificate → select `rootCA.pem`.
3. **iPhone:** send the file via AirDrop/mail, install the profile in
   Settings → General → VPN & Device Management, then enable full trust in
   Settings → General → About → Certificate Trust Settings.

Then open `https://192.168.1.50:8443` on the phone — the scanner camera works.

## 5. Renewal

mkcert certificates last ~2 years (`mkcert -install` CA lasts ~10). When the
cert expires, re-run step 2 and restart the server.

## Why not Let's Encrypt?

Let's Encrypt can't issue certificates for bare IP addresses, and a LAN-only
host has no public DNS name to validate. mkcert's local CA is the standard
answer for trusted LAN HTTPS.
