-- Runs once, when the data volume is first created (after the image's own PostGIS setup).
-- The postgis image enables extensions the game does not use; dropping them keeps the
-- database identical to the Prisma schema, so `prisma migrate dev` reports no drift.
DROP EXTENSION IF EXISTS postgis_tiger_geocoder;
DROP EXTENSION IF EXISTS postgis_topology;
DROP EXTENSION IF EXISTS fuzzystrmatch;
DROP SCHEMA IF EXISTS tiger_data;

-- Separate database for integration tests (api and jobs).
CREATE DATABASE gioco_test;
\connect gioco_test
CREATE EXTENSION IF NOT EXISTS postgis;
