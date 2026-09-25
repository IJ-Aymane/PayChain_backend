# PayChain Backend

Standalone Express API for PayChain.

## Local Run

```bash
npm install
cp .env.example .env
npm run dev
```

The API defaults to `http://localhost:10000/api` when using the Docker/Render port, or whatever `PORT` is set to.

## Render Docker Deploy

Create a Docker Web Service with this directory as the repository/root directory.

Required environment variables:

```text
DB_CONNECTION_STRING=mysql://USER:PASSWORD@HOST:PORT/DATABASE?ssl-mode=REQUIRED
MYSQL_SSL=true
MYSQL_SSL_CA_FILE=/etc/secrets/aiven-ca.pem
FRONTEND_ORIGIN=https://your-frontend.onrender.com
JWT_SECRET=change_this_to_a_long_random_secret_at_least_24_chars
ENCRYPTION_KEY=change_this_to_a_32_byte_or_long_random_secret
BLOCKCHAIN_ENABLED=false
LOCAL_BLOCKCHAIN_ENABLED=true
```

For Aiven, copy the Service URI from the dashboard. The backend supports `ssl-mode=REQUIRED`. Add the Aiven CA certificate as a Render Secret File named `aiven-ca.pem`, then set `MYSQL_SSL_CA_FILE=/etc/secrets/aiven-ca.pem`. You can also paste the certificate directly into `MYSQL_SSL_CA`.

Render injects `PORT`; the Dockerfile defaults to `10000` for local Docker compatibility.
