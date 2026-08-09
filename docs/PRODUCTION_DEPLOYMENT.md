# Production deployment checklist

Frontend and backend must be separate HTTPS services. The backend runs on Railway with a dedicated PostgreSQL database. The frontend may run on the current StockFlow Sites host or on Vercel after the owner's Vercel account and domain are connected.

Required backend variables: `NODE_ENV=production`, `DATABASE_URL`, a unique `JWT_SECRET`, `JWT_EXPIRES_IN=8h`, exact comma-separated `CLIENT_URLS`, `INSTANCE_COMPANY_CODE`, VAPID keys, and optional WhatsApp Cloud API credentials. Railway start command is `npm start`, which applies pending migrations before Express starts.

Use a customer subdomain for the frontend and an API subdomain for Railway. Add both DNS records at the domain registrar, enable HTTPS, restrict CORS to the exact frontend origin, and remove temporary origins after cutover. Monitor `/api/health`; structured request logs include a request ID also returned to the browser on server errors.
