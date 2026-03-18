import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

const client = postgres(process.env.DATABASE_URL || 'postgres://leszyrun:leszyrun@localhost:5432/leszyrun')

export const db = drizzle(client, { schema })
