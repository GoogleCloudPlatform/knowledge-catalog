// API client for AlloyDB for PostgreSQL.
//
// Two surfaces, as with Spanner -- but only one of them is REST:
//
//   * Admin (AlloyDbClient) -- getConnectionInfo, to learn the address an
//     instance answers on, and generateClientCertificate, to learn the
//     certificate authority that signs it. Both are ordinary
//     alloydb.googleapis.com calls over the shared ApiContext, so they look
//     like every other client in this directory.
//   * Data (AlloyDbDataClient) -- sessions, transactions, statements. This one
//     is NOT REST, because there is no such thing: AlloyDB's API is
//     administrative, and its data plane is the PostgreSQL wire protocol.
//     Spanner can be reached with `fetch` and a bearer token; AlloyDB cannot.
//
// That asymmetry is the whole reason this file is longer than spanner.ts, and
// it is worth being explicit about how it is bridged, because three things had
// to be decided rather than looked up.
//
// WHAT SPEAKS POSTGRES. Bun's built-in SQL client, reached by a dynamic import
// so that merely loading this module does not require Bun. Nothing is added to
// package.json. That is not thrift for its own sake: every other client here is
// hand-rolled over `fetch` precisely so `dist/kcmd` stays a single binary with
// no native build step, and taking on a driver plus a connector -- the usual
// answer -- would end that property for the one backend that needs it. The
// import is dynamic so that a Node consumer of `libts` that never touches
// AlloyDB still loads, and one that does touch it gets a sentence explaining
// why rather than a module-resolution stack.
//
// HOW IT AUTHENTICATES. The IAM principal ApiContext already holds, as the
// database password -- which is what AlloyDB's IAM authentication expects an
// access token to be. So there is no second credential, no password in a
// profile, and no secret to store: whoever `gcloud` says you are is who the
// database sees. The username is that principal's email, read back from the
// token rather than configured, so it cannot drift from the credential it
// accompanies.
//
// HOW IT IS ENCRYPTED. Against the cluster's own certificate authority,
// fetched from the admin API. An AlloyDB instance presents a certificate signed
// by a CA that exists for exactly one cluster, so verifying the chain against
// that CA establishes which cluster answered -- see `tlsFor` for why the
// hostname is not what is checked, and what is checked instead.
//
// The surface below is deliberately the one SpannerDataClient offers -- the
// same six methods, the same ApiResult shape, the same "every scalar comes back
// a string" convention. The runtime was written against Spanner, and the
// cheapest way to be sure a second backend behaves is to give the callers
// nothing new to handle. Where PostgreSQL has no equivalent of a Spanner
// concept, this maps rather than invents: a session is a reserved connection, a
// transaction id is that connection's name because a connection has at most one
// transaction, and a SQLSTATE becomes the HTTP status the runtime's
// commit-outcome rules already reason about.

import * as crypto from 'crypto';

import * as api from './api';
import * as context from './context';


// The instance address and identity, as returned by getConnectionInfo.
export interface ConnectionInfo {
  ipAddress?: string;
  publicIpAddress?: string;
  pscDnsName?: string;
  instanceUid?: string;
  [key: string]: any;
}


// A freshly minted client certificate and the CA that signed it. We ask for
// this to obtain `caCert`; the chain is used as the client certificate when the
// instance asks for one.
export interface ClientCertificate {
  pemCertificateChain?: string[];
  caCert?: string;
  [key: string]: any;
}


// The AlloyDB ADMIN surface. Everything here is a normal REST call on the
// shared ApiContext; none of it moves data.
export class AlloyDbClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://alloydb.googleapis.com', 'v1', ctx);
  }

  // Where an instance answers, and which instance it is. The address depends
  // on how the cluster was configured -- a private IP inside the VPC, a public
  // IP, or a Private Service Connect endpoint -- so this is asked rather than
  // constructed.
  async getConnectionInfo(
      project: string, location: string, cluster: string,
      instance: string): Promise<api.ApiResult<ConnectionInfo>> {
    return await this._get<ConnectionInfo>(
        `projects/${project}/locations/${location}/clusters/${cluster}` +
        `/instances/${instance}/connectionInfo`);
  }

  // Signs `publicKey` with the cluster's CA and returns both the resulting
  // chain and the CA itself. The CA is the part this file needs; a public key
  // must be supplied to get it, which is why the caller generates a throwaway
  // keypair.
  async generateClientCertificate(
      project: string, location: string, cluster: string, publicKey: string,
      certDuration = '3600s'): Promise<api.ApiResult<ClientCertificate>> {
    return await this._post<ClientCertificate>(
        `projects/${project}/locations/${location}/clusters/${
            cluster}:generateClientCertificate`,
        {publicKey, certDuration});
  }
}


// ---------------------------------------------------------------------------
// Statement translation
// ---------------------------------------------------------------------------

// GoogleSQL types, as the runtime declares them on a parameter, mapped to the
// PostgreSQL type each placeholder is cast to. The runtime sends a value it has
// already parsed to the field's declared type and says which type that was; a
// cast carries that statement across rather than leaving PostgreSQL to infer a
// type from a parameter it has never seen used. Inference is not merely
// imprecise here -- `WHERE placed_on = $1` with a text parameter is an error in
// PostgreSQL, not a coercion -- so the declared type is what makes the
// comparison legal.
const PG_TYPES: Record<string, string> = {
  'BOOL': 'boolean',
  'BYTES': 'bytea',
  'DATE': 'date',
  'FLOAT64': 'double precision',
  'INT64': 'bigint',
  'JSON': 'jsonb',
  'NUMERIC': 'numeric',
  'STRING': 'text',
  'TIMESTAMP': 'timestamptz',
};


/** A statement rewritten for PostgreSQL: `$n` placeholders and their values. */
export interface PositionalStatement {
  text: string;
  values: unknown[];
}


/**
 * Rewrites a statement's `@name` parameters into PostgreSQL's positional `$n`,
 * returning the values in the order the placeholders now expect.
 *
 * The runtime names its parameters, in one syntax, everywhere: the action
 * planner writes `@order`, the lookup builder writes `@f_0`, and a profile
 * author writes whatever the model's arguments are called. Translating here
 * rather than at each of those sites is what lets a profile be the only
 * PostgreSQL-specific thing about an AlloyDB deployment -- the SQL in it is
 * PostgreSQL, but its parameters look the way parameters look everywhere else
 * in this system.
 *
 * A name that repeats reuses its placeholder, so `WHERE a = @x OR b = @x`
 * sends one value rather than the same value twice.
 *
 * Only a parameter is rewritten. An `@` inside a string literal, a quoted
 * identifier, a dollar-quoted body or a comment is left exactly as written --
 * PostgreSQL has operators spelled with `@`, and a memo containing an email
 * address is an ordinary thing for an action to write.
 */
// The index just past a stretch of `sql` beginning at `i` that the parser
// reads as literal text -- a quoted string, a quoted identifier, a
// dollar-quoted body, a line comment, a block comment -- or -1 if `i` begins
// none of those.
//
// Two passes over a statement need this: rewriting its parameters, and deciding
// whether it is one command or several. They have to agree about what counts as
// literal, and the way to make two things agree is to give them one answer.
function opaqueEnd(sql: string, i: number): number {
  const ch = sql[i];

  // A single-quoted string, or a quoted identifier. PostgreSQL escapes a quote
  // by doubling it, which needs no special case: the closing quote of `'it''s'`
  // is read as a close followed by an open, and the scan ends in the same place
  // either way.
  if (ch === `'` || ch === '"') {
    const end = sql.indexOf(ch, i + 1);
    return end === -1 ? sql.length : end + 1;
  }

  // A dollar-quoted body: `$tag$ ... $tag$`. Everything between the tags is
  // literal, including `@`, `;` and quotes.
  const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
  if (dollar) {
    const tag = dollar[0];
    const end = sql.indexOf(tag, i + tag.length);
    return end === -1 ? sql.length : end + tag.length;
  }

  if (ch === '-' && sql[i + 1] === '-') {
    const end = sql.indexOf('\n', i);
    return end === -1 ? sql.length : end;
  }

  if (ch === '/' && sql[i + 1] === '*') {
    const end = sql.indexOf('*/', i + 2);
    return end === -1 ? sql.length : end + 2;
  }

  return -1;
}


/**
 * Whether `sql` carries a second command.
 *
 * A semicolon ending the only statement is still one command, and so is a
 * comment or whitespace trailing it; anything else after a semicolon is
 * another command.
 *
 * This is asked because a statement reaches this client from a binding profile,
 * and a second command smuggled past a semicolon would run outside everything
 * that examined the first -- its guards, its constraints, its parameters.
 * PostgreSQL's extended protocol already refuses a multi-command string, but
 * only when the call carries parameters: a statement that binds none goes out
 * in simple query mode, where the server runs every command in it. Asking here
 * makes the answer the same either way.
 */
export function hasMultipleCommands(sql: string): boolean {
  let i = 0;
  let ended = false;
  while (i < sql.length) {
    const opaque = opaqueEnd(sql, i);
    if (opaque !== -1) {
      // A comment after the final semicolon is trailing matter. A literal there
      // is not a command either, but it is not nothing, and refusing it costs
      // less than working out what it was meant to be.
      const ch = sql[i];
      if (ended && (ch === `'` || ch === '"' || ch === '$')) return true;
      i = opaque;
      continue;
    }
    const ch = sql[i];
    if (ch === ';') {
      ended = true;
    } else if (ended && !/\s/.test(ch)) {
      return true;
    }
    i++;
  }
  return false;
}


export function toPositional(
    sql: string, params: Record<string, unknown> = {},
    paramTypes: Record<string, {code: string}> = {}): PositionalStatement {
  const values: unknown[] = [];
  const slot = new Map<string, number>();
  let out = '';
  let i = 0;

  while (i < sql.length) {
    // Anything the parser reads as literal text is copied across untouched.
    const opaque = opaqueEnd(sql, i);
    if (opaque !== -1) {
      out += sql.slice(i, opaque);
      i = opaque;
      continue;
    }

    const ch = sql[i];
    if (ch === '@') {
      const name = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      // An `@` that begins no identifier is an operator, not a parameter.
      if (name) {
        const key = name[1];
        let index = slot.get(key);
        if (index === undefined) {
          values.push(params[key] ?? null);
          index = values.length;
          slot.set(key, index);
        }
        const pgType = PG_TYPES[paramTypes[key]?.code ?? ''];
        out += pgType ? `$${index}::${pgType}` : `$${index}`;
        i += name[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return {text: out, values};
}


// The HTTP status a PostgreSQL error is reported as, so that callers written
// against the Spanner client's statuses reach the same conclusion.
//
// The distinction that matters is the one `run_action` draws around a commit:
// an error it can be SURE did not commit is worth retrying and says so, while
// anything else leaves the outcome unknown and must not claim otherwise. A
// serialization failure and a deadlock are PostgreSQL's version of Spanner's
// ABORTED -- the transaction is gone and applied nothing -- so they map to the
// 409 the runtime already treats that way. A constraint violation is equally
// definite. Anything unrecognized maps to 500, which the runtime reads as
// indeterminate, because an error this code has never seen is not one to make
// promises about.
export function statusForSqlState(sqlState: string|undefined): number {
  if (!sqlState) return 500;
  // 40003 statement_completion_unknown is the one member of class 40 that is
  // not a rollback: PostgreSQL raises it when it cannot say whether the
  // transaction committed. Reporting it as 409 would tell the runtime the write
  // definitely did not land, and a caller acting on that would apply it a
  // second time -- so it takes the indeterminate 500, which is what an unknown
  // outcome is.
  if (sqlState === '40003') return 500;
  // 40001 serialization_failure, 40P01 deadlock_detected: retryable, nothing
  // applied. 23xxx: an integrity constraint refused the statement outright.
  if (sqlState.startsWith('40') || sqlState.startsWith('23')) return 409;
  // 42501 insufficient_privilege is an authorization answer, not a syntax one,
  // and sends the reader somewhere different.
  if (sqlState === '42501') return 403;
  // 28xxx invalid_authorization_specification, including a rejected token.
  if (sqlState.startsWith('28')) return 401;
  // 42xxx: syntax error, undefined table, undefined column -- the statement is
  // wrong and rerunning it unchanged will fail the same way.
  if (sqlState.startsWith('42') || sqlState.startsWith('22')) return 400;
  // 3D000 invalid_catalog_name, 3F000 invalid_schema_name.
  if (sqlState.startsWith('3D') || sqlState.startsWith('3F')) return 404;
  return 500;
}


// A result set in the shape the Spanner data client returns, which is what the
// runtime reads. Positional rows, every scalar a string, nulls preserved.
export interface ResultSet {
  metadata?: {rowType?: {fields?: Array<{name?: string; type?: any}>}};
  rows?: Array<Array<string|null>>;
  stats?: {rowCountExact?: string; [key: string]: any};
  [key: string]: any;
}


// Renders one PostgreSQL value the way the Spanner REST surface renders it: as
// a string, or null. Doing this here is what lets `run_action` and the agent
// tools read both backends with one set of rules -- they already parse from
// strings, because that is the only thing Spanner ever gave them.
export function asString(value: unknown): string|null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}


// ---------------------------------------------------------------------------
// The data client
// ---------------------------------------------------------------------------

// What this file uses of Bun's SQL client. Declared structurally rather than
// imported as a type so that `tsc` type-checks this file without resolving
// Bun's types, and so the shape being depended on is written down where it is
// depended on.
// What `unsafe` returns: a thenable that yields rows keyed by column name when
// awaited directly, and rows as arrays when narrowed with `.values()` first.
// This client always narrows -- see `_execute` for why a keyed row is the wrong
// shape to read a result in.
interface PgQuery extends Promise<any> {
  values(): Promise<any>;
}

interface PgConnection {
  unsafe(text: string, values?: unknown[]): PgQuery;
  release?(): void;
}

interface PgPool {
  reserve(): Promise<PgConnection>;
  close(opts?: {timeout?: number}): Promise<void>;
}


/** How to reach an AlloyDB instance, once everything has been looked up. */
interface Connection {
  host: string;
  database: string;
  username: string;
  ca: string;
  cert?: string;
  key?: string;
}


/**
 * The AlloyDB data plane, presenting the surface SpannerDataClient presents.
 *
 * Read-write transactions are explicit rather than a callback wrapper, for the
 * same reason they are on the Spanner client: the runtime's gate runs between
 * the write and the commit, so the decision to commit has to stay with the
 * caller. Bun's `sql.begin` would take that decision away.
 *
 * Nothing connects until a statement is run. Resolving a store builds one of
 * these for every model in a scope, and a scope that is only being listed
 * should not open a database connection, let alone one per model.
 */
export class AlloyDbDataClient {
  private readonly _ctx: context.ApiContext;
  private readonly _admin: AlloyDbClient;
  private readonly _project: string;
  private readonly _location: string;
  private readonly _cluster: string;
  private readonly _instance: string;
  private readonly _databaseId: string;
  private readonly _name: string;

  private _pool?: PgPool;
  private _connecting?: Promise<PgPool>;
  private readonly _sessions = new Map<string, PgConnection>();
  // Sessions whose connection is inside a transaction block, so that one left
  // open can be reset before the connection goes back to the pool. Entered on a
  // BEGIN that succeeded, left on a COMMIT or ROLLBACK that did.
  private readonly _inTransaction = new Set<string>();
  private _nextSession = 0;

  constructor(
      ctx: context.ApiContext, project: string, location: string,
      cluster: string, instance: string, database: string) {
    this._ctx = ctx;
    this._admin = new AlloyDbClient(ctx);
    this._project = project;
    this._location = location;
    this._cluster = cluster;
    this._instance = instance;
    this._databaseId = database;
    this._name = `projects/${project}/locations/${location}/clusters/${
        cluster}/instances/${instance}/databases/${database}`;
  }

  /** The store's resource name, as it appears in the runtime's messages. */
  get database(): string {
    return this._name;
  }

  /**
   * Runs `fn` with a reserved connection and releases it afterwards, including
   * when `fn` throws. A connection held by a transaction that nobody finished
   * would block the next caller rather than age out, which is the difference
   * from a leaked Spanner session and the reason this one is released in a
   * `finally` that cannot be skipped.
   */
  async withSession<T>(fn: (sessionName: string) => Promise<T>): Promise<T> {
    const pool = await this._connect();
    const connection = await pool.reserve();
    const sessionName = `${this._name}/connections/${++this._nextSession}`;
    this._sessions.set(sessionName, connection);
    try {
      return await fn(sessionName);
    } finally {
      // A connection goes back to the pool; a Spanner session is deleted. So a
      // transaction still open here is not discarded with the session -- it
      // would travel to whoever reserves this connection next, whose every
      // statement would then fail with `25P02 current transaction is aborted`.
      // The runtime leaves one open on purpose: when a commit's outcome is
      // unknown it deliberately does not roll back, because it must not tell a
      // caller the write did not happen. Cleaning the connection is a different
      // question from what the caller is told, and it belongs here.
      if (this._inTransaction.has(sessionName)) {
        try {
          await this._run(sessionName, 'ROLLBACK');
        } catch {
        }
      }
      this._inTransaction.delete(sessionName);
      this._sessions.delete(sessionName);
      // Releasing must not become the caller's result, for the reason the
      // Spanner client gives about deleting a session: a failure here after a
      // successful commit would replace the outcome with an error, and a caller
      // reading that as "the write did not happen" would apply it twice.
      try {
        connection.release?.();
      } catch {
      }
    }
  }

  /**
   * Begins a read-write transaction on `sessionName`.
   *
   * The transaction id IS the session name. A PostgreSQL connection has at most
   * one transaction, so there is nothing else it could be, and inventing a
   * token would suggest a second transaction could be opened on the same
   * connection.
   */
  async beginReadWrite(sessionName: string):
      Promise<api.ApiResult<{id?: string}>> {
    const begun = await this._run(sessionName, 'BEGIN');
    if (begun.status < 200 || begun.status >= 300) {
      return {status: begun.status, message: begun.message};
    }
    this._inTransaction.add(sessionName);
    return {status: 200, result: {id: sessionName}};
  }

  /**
   * Runs one statement inside the session's transaction, DML or query alike. A
   * read observes the transaction's own uncommitted writes, as it does on
   * Spanner -- PostgreSQL's default isolation gives read-your-writes within a
   * transaction -- so a caller can inspect what it just wrote before deciding
   * to commit.
   *
   * `transactionId` is accepted to match the Spanner client and checked rather
   * than ignored: it names the session whose transaction the statement belongs
   * to, and a mismatch means the caller believes it holds a transaction that
   * this connection does not have.
   */
  async executeSql(sessionName: string, transactionId: string, stmt: {
    sql: string;
    params?: Record<string, any>;
    paramTypes?: Record<string, {code: string}>
  }): Promise<api.ApiResult<ResultSet>> {
    if (transactionId !== sessionName) {
      return {
        status: 400,
        message: `Transaction '${transactionId}' does not belong to this ` +
            `connection. On AlloyDB a transaction is its connection, so a ` +
            `statement cannot be run on another one's.`,
      };
    }
    return await this._execute(sessionName, stmt);
  }

  /**
   * Runs one statement outside any transaction. Spanner's equivalent is a
   * single-use strong read; PostgreSQL runs a statement sent outside a
   * transaction block in an implicit one, which is the same guarantee for a
   * single statement.
   */
  async executeQuery(sessionName: string, stmt: {
    sql: string;
    params?: Record<string, any>;
    paramTypes?: Record<string, {code: string}>
  }): Promise<api.ApiResult<ResultSet>> {
    return await this._execute(sessionName, stmt);
  }

  async commit(sessionName: string, transactionId: string):
      Promise<api.ApiResult<{commitTimestamp?: string}>> {
    if (transactionId !== sessionName) {
      return {
        status: 400,
        message:
            `Transaction '${transactionId}' does not belong to this connection.`
      };
    }
    // PostgreSQL's COMMIT reports no timestamp, and the transaction's own
    // clock reading is the closest true answer -- `now()` inside the
    // transaction is its start time, which is what Spanner's commit timestamp
    // is not. Reading the server clock immediately after committing is
    // honest about being an observation rather than the commit's own record.
    const committed = await this._run(sessionName, 'COMMIT');
    if (committed.status < 200 || committed.status >= 300) {
      // Left marked as in a transaction. A COMMIT that failed may have rolled
      // back or may have left the block open, and the connection is reset on
      // release either way rather than guessed about here.
      return {status: committed.status, message: committed.message};
    }
    this._inTransaction.delete(sessionName);
    const clock = await this._execute(sessionName, {sql: 'SELECT now()'});
    return {
      status: 200,
      result: {commitTimestamp: clock.result?.rows?.[0]?.[0] ?? undefined},
    };
  }

  async rollback(sessionName: string, transactionId: string):
      Promise<api.ApiResult<{}>> {
    if (transactionId !== sessionName) {
      return {
        status: 400,
        message:
            `Transaction '${transactionId}' does not belong to this connection.`
      };
    }
    const rolled = await this._run(sessionName, 'ROLLBACK');
    if (rolled.status < 200 || rolled.status >= 300) {
      return {status: rolled.status, message: rolled.message};
    }
    this._inTransaction.delete(sessionName);
    return {status: 200, result: {}};
  }

  /** Closes the pool. A caller that is finished with the store calls this. */
  async close(): Promise<void> {
    const pool = this._pool;
    this._pool = undefined;
    this._connecting = undefined;
    if (pool) await pool.close({timeout: 5});
  }

  // Runs a statement with no parameters on a session's connection.
  private async _run(sessionName: string, text: string):
      Promise<api.ApiResult<ResultSet>> {
    return await this._execute(sessionName, {sql: text});
  }

  private async _execute(sessionName: string, stmt: {
    sql: string;
    params?: Record<string, any>;
    paramTypes?: Record<string, {code: string}>
  }): Promise<api.ApiResult<ResultSet>> {
    const connection = this._sessions.get(sessionName);
    if (!connection) {
      return {
        status: 400,
        message: `No open connection named '${sessionName}' on ${this._name}.`,
      };
    }
    const {text, values} =
        toPositional(stmt.sql, stmt.params ?? {}, stmt.paramTypes ?? {});
    if (hasMultipleCommands(text)) {
      return {
        status: 400,
        message: `A statement sent to ${this._name} carries more than one ` +
            `command. A statement from a profile or from the planner is one ` +
            `statement; everything that examined this call examined the ` +
            `first command, so the rest are refused rather than run ` +
            `unexamined.`,
      };
    }
    let result: any;
    try {
      // `.values()` asks for rows as arrays rather than as objects keyed by
      // column name. Two columns of one SELECT can share an output name -- a
      // profile may bind two fields to the same column -- and a keyed row would
      // collapse them into one entry, shortening the row and shifting every
      // caller, all of whom read a row by position.
      result = values.length ? await connection.unsafe(text, values).values() :
                               await connection.unsafe(text).values();
    } catch (err: any) {
      // A PostgreSQL error carries a SQLSTATE; a socket or TLS failure does
      // not, and 500 leaves it indeterminate, which is what an unanswered
      // statement is.
      const sqlState = err?.errno ?? err?.code ?? err?.sqlState;
      return {
        status: statusForSqlState(
            typeof sqlState === 'string' ? sqlState : undefined),
        message: `${err?.message ?? err}`,
      };
    }
    return {status: 200, result: shapeResult(result)};
  }

  // Opens the pool, once. Concurrent callers share the one attempt rather than
  // each looking up the address and minting a certificate.
  private async _connect(): Promise<PgPool> {
    if (this._pool) return this._pool;
    if (!this._connecting) {
      this._connecting = this._openPool().then(pool => {
        this._pool = pool;
        return pool;
      });
      // A failed attempt must not be cached as the answer: the next caller
      // should try again rather than be handed the same rejection forever.
      this._connecting.catch(() => {
        this._connecting = undefined;
      });
    }
    return await this._connecting;
  }

  private async _openPool(): Promise<PgPool> {
    const {SQL} = await loadBunSql();
    const connection = await this._resolveConnection();
    return new SQL({
             hostname: connection.host,
             port: 5432,
             database: connection.database,
             username: connection.username,
             // A function, not a string: Bun calls it per connection, so a pool
             // that outlives an access token mints a fresh one instead of
             // failing to reconnect an hour in.
             password: async () => {
               this._ctx.refresh();
               return this._ctx.token;
             },
             tls: tlsFor(connection),
             max: 4,
           }) as unknown as PgPool;
  }

  // Everything that has to be asked of Google before a connection can be
  // opened: where the instance is, who we are, and who signs its certificate.
  private async _resolveConnection(): Promise<Connection> {
    const info = await this._admin.getConnectionInfo(
        this._project, this._location, this._cluster, this._instance);
    if (info.status < 200 || info.status >= 300) {
      throw new Error(
          `Could not look up ${this._name}: ${
              info.message ??
              info.status}. The caller needs alloydb.instances.get ` +
          `on the cluster.`);
    }
    // A private IP is the default and the one to prefer when both exist: it is
    // what an instance inside the VPC should use, and reaching for the public
    // address there would leave the network unnecessarily.
    const host = process.env.ALLOYDB_HOST || info.result?.ipAddress ||
        info.result?.publicIpAddress || info.result?.pscDnsName;
    if (!host) {
      throw new Error(
          `AlloyDB instance ${this._instance} reports no address ` +
          `to connect to. Enable a public IP, run inside its VPC, or set ` +
          `ALLOYDB_HOST.`);
    }

    const username = process.env.ALLOYDB_USER || await this._principal();
    const {ca, cert, key} = await this._clusterCertificates();
    return {host, database: this._databaseId, username, ca, cert, key};
  }

  // The IAM principal the ambient credential belongs to, which is the database
  // user AlloyDB's IAM authentication expects. Read from the token rather than
  // configured: a username that can disagree with the credential beside it is a
  // failure that reads as a permission problem.
  private async _principal(): Promise<string> {
    const res =
        await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${
            encodeURIComponent(this._ctx.token)}`);
    const body = await res.json().catch(() => ({})) as {email?: string};
    if (!res.ok || !body.email) {
      throw new Error(
          `Could not read the IAM principal from the current credential, so ` +
          `there is no database user to connect as. Set ALLOYDB_USER to the ` +
          `AlloyDB IAM user to log in as.`);
    }
    // A service account logs in under its email with the domain suffix
    // removed; a user account logs in under its email as written.
    return body.email.endsWith('.gserviceaccount.com') ?
        body.email.slice(0, -'.gserviceaccount.com'.length) :
        body.email;
  }

  // The cluster's certificate authority, and a client certificate it signed.
  // Obtaining the CA requires presenting a public key, so one is generated for
  // the purpose and discarded with the process.
  private async _clusterCertificates():
      Promise<{ca: string; cert?: string; key?: string}> {
    const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {type: 'spki', format: 'pem'},
      privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    });
    const issued = await this._admin.generateClientCertificate(
        this._project, this._location, this._cluster, publicKey as string);
    if (issued.status < 200 || issued.status >= 300 || !issued.result?.caCert) {
      throw new Error(
          `Could not obtain the certificate authority for cluster ${
              this._cluster}: ${issued.message ?? issued.status}. Without it ` +
          `there is no way to verify which database answered, so no ` +
          `connection is attempted.`);
    }
    return {
      ca: issued.result.caCert,
      cert: issued.result.pemCertificateChain?.join('\n'),
      key: privateKey as string,
    };
  }
}


/**
 * The TLS settings for a verified AlloyDB connection.
 *
 * The certificate is verified -- `rejectUnauthorized` is true -- against the
 * cluster's own CA and nothing else. What is NOT checked is the hostname, and
 * that is a deliberate answer to a real question rather than a shortcut.
 *
 * An AlloyDB instance is dialed by IP address, and the certificate it presents
 * does not name that IP: the address is assigned by the network, while the
 * certificate names the instance. Requiring the two to match would fail every
 * connection. The usual alternative -- disable verification -- would accept any
 * certificate at all, which is the thing worth refusing.
 *
 * What is checked instead is stronger than a hostname would be. The CA here is
 * not a public root; it is generated per cluster and signs certificates for
 * exactly that cluster, and it was just fetched over an authenticated admin
 * call naming the cluster the profile asked for. So a chain that validates
 * against it proves the instance belongs to the cluster the deployment target
 * names -- which is the question a hostname check is a proxy for, asked
 * directly.
 */
function tlsFor(connection: Connection) {
  return {
    ca: connection.ca,
    cert: connection.cert,
    key: connection.key,
    rejectUnauthorized: true,
    // Returning undefined means "no objection". The identity was established
    // by the chain; see above.
    checkServerIdentity: () => undefined,
  };
}


// Bun's SQL client, or a sentence about why there is none. Dynamic so that
// importing this module never requires Bun -- only running a statement does.
async function loadBunSql(): Promise<{SQL: new (opts: any) => unknown}> {
  try {
    return await import('bun') as any;
  } catch {
    throw new Error(
        `Reaching AlloyDB needs Bun's PostgreSQL client, and this process is ` +
        `not running under Bun. AlloyDB has no REST data API -- unlike ` +
        `Spanner and BigQuery, its data plane is the PostgreSQL wire ` +
        `protocol -- so run this under \`bun\` or with the \`kcmd\` binary.`);
  }
}


// Turns Bun's result into the Spanner-shaped ResultSet the runtime reads.
//
// The rows arrive as arrays, because `_execute` asked for them that way, and
// the affected-row count is hung off the array. So what is left to do is render
// each value the way the Spanner client renders it.
//
// No column names are attached. `.values()` does not carry them, and the
// runtime reads a row by position and never asks what a column was called --
// naming them would mean inventing names nobody reads.
export function shapeResult(result: any): ResultSet {
  const rows: any[] = Array.isArray(result) ? result : [];
  const count = result?.count;
  return {
    rows: rows.map(row => (row as unknown[]).map(value => asString(value))),
    ...(typeof count === 'number' ? {stats: {rowCountExact: `${count}`}} : {}),
  };
}
