import {loadSqlEngine} from '../src/libts/semantic/sql_parser.js';

// Enable graph inheritance DDL lowering across existing test suites by default;
// tests verifying the default ignore-and-warn behavior unset this explicitly.
process.env.KCMD_GRAPH_INHERITANCE = '1';

await loadSqlEngine();
