import { config } from 'dotenv'

// Load real env for integration tests when a .env file is present.
config({ path: '.env' })

// Unit tests mock the db and never open a connection, but db/client.ts throws
// at import time without this — provide a harmless fallback that real env wins over.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://fake:fake@localhost:5432/fake'
}
