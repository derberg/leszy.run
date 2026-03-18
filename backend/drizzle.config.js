export default {
  dialect: 'postgresql',
  schema: './src/db/schema.js',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://leszyrun:leszyrun@localhost:5432/leszyrun',
  },
}
