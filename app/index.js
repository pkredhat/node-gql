import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { startStandaloneServer } from '@apollo/server/standalone';
import DataLoader from 'dataloader';
import pg from 'pg';
import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';

const { Pool } = pg;

// -----------------------------
// Database connections
// -----------------------------

const pgPool = new Pool({
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

const mariaPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'appuser',
  password: process.env.MYSQL_PASSWORD || 'apppass',
  database: process.env.MYSQL_DATABASE || 'appdb',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
});

sqlite3.verbose();
const defaultSqliteDir = process.env.SQLITE_MOUNT_PATH || process.env.SQLITE_DIR || '.';
const defaultSqliteFile = process.env.SQLITE_DB_FILE || 'reviews.db';
const sqliteDatabasePath = path.resolve(
  process.env.SQLITE_PATH || path.join(defaultSqliteDir, defaultSqliteFile)
);

const sqliteDb = new sqlite3.Database(
  sqliteDatabasePath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error('❌ SQLite connection failed:', err.message);
    }
  }
);

const sqliteReady = new Promise((resolve, reject) => {
  sqliteDb.once('open', resolve);
  sqliteDb.once('error', reject);
});

const sqliteAll = promisify(sqliteDb.all.bind(sqliteDb));
const sqliteGet = promisify(sqliteDb.get.bind(sqliteDb));
const sqliteRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });

// -----------------------------
// Row mappers & utilities
// -----------------------------

const mapAuthorRow = (row) => ({
  id: row.id?.toString() ?? null,
  firstname: row.firstname,
  lastname: row.lastname,
  birthdate: normalizeDate(row.birthdate),
  deathdate: normalizeDate(row.deathdate),
  favoriteColor: row.favoritecolor ?? row.favorite_color ?? null,
  bio: row.bio,
  nationality: row.nationality,
  dateCreated: normalizeDateTime(row.datecreated ?? row.date_created),
});

const mapBookRow = (row) => ({
  id: row.id?.toString() ?? null,
  authorId: row.authorid?.toString() ?? row.author_id?.toString() ?? null,
  title: row.title,
  synopsis: row.synopsis,
  isbn: row.isbn,
  publicationDate: normalizeDate(row.publicationdate ?? row.publication_date),
});

const mapReviewRow = (row) => ({
  id: row.id?.toString() ?? null,
  bookId: row.bookid?.toString() ?? row.book_id?.toString() ?? null,
  reviewerName: row.reviewername ?? row.reviewer_name,
  rating: typeof row.rating === 'number' ? row.rating : Number(row.rating ?? 0),
  comment: row.comment,
});

const normalizeDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const str = value.toString();
  return str.length >= 10 ? str.slice(0, 10) : str;
};

const normalizeDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value.toString();
};

const buildSqlPlaceholders = (count) => new Array(count).fill('?').join(', ');

// -----------------------------
// DataLoaders
// -----------------------------

const createLoaders = () => ({
  authorById: new DataLoader(async (ids) => {
    if (ids.length === 0) return [];
    const numericIds = ids.map((id) => Number(id));
    const { rows } = await pgPool.query(
      `SELECT id, firstname, lastname, birthdate, deathdate, favoritecolor, bio, nationality, datecreated
       FROM authors
       WHERE id = ANY($1)`,
      [numericIds]
    );
    const authorById = new Map(rows.map((row) => [Number(row.id), mapAuthorRow(row)]));
    return numericIds.map((id) => authorById.get(id) ?? null);
  }),
  booksByAuthorId: new DataLoader(async (ids) => {
    if (ids.length === 0) return [];
    const numericIds = ids.map((id) => Number(id));
    const placeholders = buildSqlPlaceholders(numericIds.length);
    const [rows] = await mariaPool.query(
      `SELECT id, author_id, title, synopsis, isbn, publicationdate
       FROM books
       WHERE author_id IN (${placeholders})`,
      numericIds
    );
    const booksByAuthor = new Map();
    for (const row of rows) {
      const key = Number(row.author_id);
      const list = booksByAuthor.get(key) ?? [];
      list.push(mapBookRow(row));
      booksByAuthor.set(key, list);
    }
    return numericIds.map((id) => booksByAuthor.get(id) ?? []);
  }),
  bookById: new DataLoader(async (ids) => {
    if (ids.length === 0) return [];
    const numericIds = ids.map((id) => Number(id));
    const placeholders = buildSqlPlaceholders(numericIds.length);
    const [rows] = await mariaPool.query(
      `SELECT id, author_id, title, synopsis, isbn, publicationdate
       FROM books
       WHERE id IN (${placeholders})`,
      numericIds
    );
    const bookById = new Map(rows.map((row) => [Number(row.id), mapBookRow(row)]));
    return numericIds.map((id) => bookById.get(id) ?? null);
  }),
  reviewsByBookId: new DataLoader(async (ids) => {
    if (ids.length === 0) return [];
    const numericIds = ids.map((id) => Number(id));
    const placeholders = buildSqlPlaceholders(numericIds.length);
    const rows = await sqliteAll(
      `SELECT id, book_id, reviewername, rating, comment
       FROM reviews
       WHERE book_id IN (${placeholders})`,
      numericIds
    );
    const reviewsByBook = new Map();
    for (const row of rows) {
      const key = Number(row.book_id);
      const list = reviewsByBook.get(key) ?? [];
      list.push(mapReviewRow(row));
      reviewsByBook.set(key, list);
    }
    return numericIds.map((id) => reviewsByBook.get(id) ?? []);
  }),
});

// -----------------------------
// GraphQL schema & resolvers
// -----------------------------

const typeDefs = `#graphql
  type Author {
    id: ID!
    firstname: String!
    lastname: String!
    birthdate: String
    deathdate: String
    favoriteColor: String
    bio: String
    nationality: String
    dateCreated: String
    books: [Book!]!
  }

  type Book {
    id: ID!
    authorId: ID!
    title: String!
    synopsis: String
    isbn: String
    publicationDate: String
    author: Author!
    reviews: [Review!]!
  }

  type Review {
    id: ID!
    bookId: ID!
    reviewerName: String!
    rating: Int!
    comment: String!
    book: Book!
  }

  type Query {
    authors: [Author!]!
    author(id: ID!): Author
    books: [Book!]!
    book(id: ID!): Book
    reviews: [Review!]!
    review(id: ID!): Review
  }

  type Mutation {
    addReview(bookId: ID!, reviewerName: String!, rating: Int!, comment: String!): Review!
  }
`;

const resolvers = {
  Query: {
    authors: async () => {
      const { rows } = await pgPool.query(
        `SELECT id, firstname, lastname, birthdate, deathdate, favoritecolor, bio, nationality, datecreated
         FROM authors
         ORDER BY id`
      );
      return rows.map(mapAuthorRow);
    },
    author: async (_, { id }) => {
      const numericId = Number(id);
      const { rows } = await pgPool.query(
        `SELECT id, firstname, lastname, birthdate, deathdate, favoritecolor, bio, nationality, datecreated
         FROM authors
         WHERE id = $1`
        ,
        [numericId]
      );
      const row = rows[0];
      return row ? mapAuthorRow(row) : null;
    },
    books: async () => {
      const [rows] = await mariaPool.query(
        `SELECT id, author_id, title, synopsis, isbn, publicationdate
         FROM books
         ORDER BY id`
      );
      return rows.map(mapBookRow);
    },
    book: async (_, { id }) => {
      const numericId = Number(id);
      const [rows] = await mariaPool.query(
        `SELECT id, author_id, title, synopsis, isbn, publicationdate
         FROM books
         WHERE id = ?
         LIMIT 1`,
        [numericId]
      );
      const row = rows[0];
      return row ? mapBookRow(row) : null;
    },
    reviews: async () => {
      await sqliteReady.catch(() => {});
      const rows = await sqliteAll(
        `SELECT id, book_id, reviewername, rating, comment
         FROM reviews
         ORDER BY id`
      );
      return rows.map(mapReviewRow);
    },
    review: async (_, { id }) => {
      await sqliteReady.catch(() => {});
      const numericId = Number(id);
      const row = await sqliteGet(
        `SELECT id, book_id, reviewername, rating, comment
         FROM reviews
         WHERE id = ?`,
        [numericId]
      );
      return row ? mapReviewRow(row) : null;
    },
  },
  Mutation: {
    addReview: async (_, { bookId, reviewerName, rating, comment }, { loaders }) => {
      const normalizedBookId = Number(bookId);
      if (Number.isNaN(normalizedBookId)) {
        throw new Error('Invalid bookId');
      }
      if (rating < 1 || rating > 5) {
        throw new Error('Rating must be between 1 and 5');
      }
      const existingBook = await loaders.bookById.load(normalizedBookId);
      if (!existingBook) {
        throw new Error(`Book ${bookId} not found`);
      }
      await sqliteReady;
      const result = await sqliteRun(
        `INSERT INTO reviews (book_id, reviewername, rating, comment)
         VALUES (?, ?, ?, ?)`,
        [normalizedBookId, reviewerName, rating, comment]
      );
      const row = await sqliteGet(
        `SELECT id, book_id, reviewername, rating, comment
         FROM reviews
         WHERE id = ?`,
        [result.lastID]
      );
      loaders.reviewsByBookId.clear(normalizedBookId);
      return mapReviewRow(row);
    },
  },
  Author: {
    books: (author, _, { loaders }) => loaders.booksByAuthorId.load(author.id),
  },
  Book: {
    author: (book, _, { loaders }) => loaders.authorById.load(book.authorId),
    reviews: (book, _, { loaders }) => loaders.reviewsByBookId.load(book.id),
  },
  Review: {
    book: (review, _, { loaders }) => loaders.bookById.load(review.bookId),
  },
};

// -----------------------------
// Startup
// -----------------------------

const server = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: true,
  plugins: [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
});

const { url } = await startStandaloneServer(server, {
  listen: { port: Number(process.env.PORT || 4000) },
  context: async () => ({
    pgPool,
    mariaPool,
    sqliteDb,
    loaders: createLoaders(),
  }),
});

console.log(`🚀 GraphQL running at ${url} ..`);

process.on('SIGINT', () => {
  console.log('Shutting down...');
  sqliteDb.close();
  pgPool.end();
  mariaPool.end();
  process.exit(0);
});
