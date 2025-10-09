import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const DATA_DIR = path.resolve(path.dirname(__filename), '..');

const authorsPath = path.join(DATA_DIR, 'authors.json');
const booksPath = path.join(DATA_DIR, 'books.json');
const reviewsPath = path.join(DATA_DIR, 'reviews.json');

const authors = JSON.parse(fs.readFileSync(authorsPath, 'utf8'));
const books = JSON.parse(fs.readFileSync(booksPath, 'utf8'));
const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

sqlite3.verbose();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(action, { retries = 30, delayMs = 2000, name }) {
  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (err) {
      attempt += 1;
      if (attempt >= retries) {
        throw new Error(`Failed to ${name ?? 'complete action'} after ${attempt} attempts: ${err.message}`);
      }
      console.warn(`Retrying ${name ?? 'operation'} (${attempt}/${retries}) in ${delayMs}ms: ${err.message}`);
      await wait(delayMs);
    }
  }
}

async function seedPostgres() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl:
      process.env.PGSSLMODE && process.env.PGSSLMODE.toLowerCase() === 'require'
        ? { rejectUnauthorized: false }
        : undefined,
  });

  let client;
  try {
    client = await withRetry(() => pool.connect(), { name: 'connect to Postgres' });

    await client.query(`
      CREATE TABLE IF NOT EXISTS authors (
        id SERIAL PRIMARY KEY,
        firstname TEXT NOT NULL,
        lastname TEXT NOT NULL,
        birthdate DATE,
        deathdate DATE,
        favoritecolor TEXT,
        bio TEXT,
        nationality TEXT,
        datecreated DATE
      );
    `);

    await client.query('BEGIN');
    for (const author of authors) {
      await client.query(
        `INSERT INTO authors (
            id, firstname, lastname, birthdate, deathdate, favoritecolor, bio, nationality, datecreated
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id)
         DO UPDATE SET
            firstname = EXCLUDED.firstname,
            lastname = EXCLUDED.lastname,
            birthdate = EXCLUDED.birthdate,
            deathdate = EXCLUDED.deathdate,
            favoritecolor = EXCLUDED.favoritecolor,
            bio = EXCLUDED.bio,
            nationality = EXCLUDED.nationality,
            datecreated = EXCLUDED.datecreated;`,
        [
          author.id,
          author.firstname,
          author.lastname,
          author.birthdate,
          author.deathdate,
          author.favoritecolor,
          author.bio,
          author.nationality,
          author.datecreated,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
    await pool.end().catch(() => undefined);
  }
  console.log(`Seeded ${authors.length} authors into Postgres`);
}

async function seedMySQL() {
  const connection = await withRetry(
    () =>
      mysql.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
      }),
    { name: 'connect to MySQL' }
  );

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS books (
        id INT AUTO_INCREMENT PRIMARY KEY,
        author_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        synopsis TEXT,
        isbn VARCHAR(32),
        publicationdate DATE
      ) ENGINE=InnoDB;
    `);

    await connection
      .query('ALTER TABLE books MODIFY COLUMN id INT AUTO_INCREMENT PRIMARY KEY;')
      .catch((err) => {
        if (err?.code !== 'ER_CANT_SET_AUTO_VALUE') {
          throw err;
        }
      });

    await connection.beginTransaction();
    for (const book of books) {
      await connection.query(
        `INSERT INTO books (id, author_id, title, synopsis, isbn, publicationdate)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           author_id = VALUES(author_id),
           title = VALUES(title),
           synopsis = VALUES(synopsis),
           isbn = VALUES(isbn),
           publicationdate = VALUES(publicationdate);`,
        [
          book.id,
          book.authorId,
          book.title,
          book.synopsis,
          book.isbn,
          book.publicationdate,
        ]
      );
    }
    await connection.commit();

    const [maxRows] = await connection.query('SELECT COALESCE(MAX(id), 0) AS maxId FROM books');
    const maxId = maxRows[0]?.maxId ?? 0;
    await connection.query('ALTER TABLE books AUTO_INCREMENT = ?', [maxId + 1]);
  } catch (err) {
    await connection.rollback().catch(() => undefined);
    throw err;
  } finally {
    await connection.end();
  }
  console.log(`Seeded ${books.length} books into MySQL`);
}

async function seedSQLite() {
  const sqlitePath = process.env.SQLITE_PATH || path.join(
    process.env.SQLITE_MOUNT_PATH || '.',
    process.env.SQLITE_DB_FILE || 'reviews.db'
  );

  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  await withRetry(async () => {
    const db = await new Promise((resolve, reject) => {
      const instance = new sqlite3.Database(sqlitePath, (err) => {
        if (err) reject(err);
        else resolve(instance);
      });
    });

    const run = (sql, params = []) =>
      new Promise((resolve, reject) => {
        db.run(sql, params, function callback(err) {
          if (err) reject(err);
          else resolve(this);
        });
      });

    const prepare = (sql) =>
      new Promise((resolve, reject) => {
        const stmt = db.prepare(sql, (err) => {
          if (err) reject(err);
          else resolve(stmt);
        });
      });

    const finalize = (statement) =>
      new Promise((resolve, reject) => {
        statement.finalize((err) => (err ? reject(err) : resolve()));
      });

    try {
      await run(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY,
        book_id INTEGER NOT NULL,
        reviewername TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT
      );`);

      await run('BEGIN TRANSACTION;');
      const stmt = await prepare(
        `INSERT OR REPLACE INTO reviews (id, book_id, reviewername, rating, comment)
         VALUES (?, ?, ?, ?, ?);`
      );

      for (const review of reviews) {
        await new Promise((resolve, reject) => {
          stmt.run(
            [review.id, review.bookId, review.reviewername, review.rating, review.comment],
            (err) => (err ? reject(err) : resolve())
          );
        });
      }

      await finalize(stmt);
      await run('COMMIT;');
    } catch (err) {
      await run('ROLLBACK;').catch(() => undefined);
      throw err;
    } finally {
      await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    }
  }, { name: 'seed SQLite reviews' });

  console.log(`Seeded ${reviews.length} reviews into SQLite at ${sqlitePath}`);
}

async function main() {
  try {
    await seedPostgres();
    await seedMySQL();
    await seedSQLite();
    console.log('✅ Database seed completed successfully');
  } catch (err) {
    console.error('❌ Database seed failed:', err);
    process.exitCode = 1;
  }
}

await main();
