import dotenv from 'dotenv';

// Loads variables from .env into process.env. Kept in its own module so it can
// be imported (and thus run) before any other module reads process.env. ESM
// hoists imports, so a module that reads env vars must import this first to be
// sure .env has been applied. dotenv.config() is idempotent and does not
// override variables already present in the environment.
dotenv.config({ quiet: true });
