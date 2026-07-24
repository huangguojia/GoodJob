export type MysqlDumpValue = string | number | boolean | null | { hex: string };

export interface MysqlDumpBatch {
  table: string;
  columns: string[];
  rows: MysqlDumpValue[][];
}

export interface MysqlDumpPlan {
  batches: MysqlDumpBatch[];
  tableRows: Record<string, number>;
  rowCount: number;
  ignoredStatements: number;
}

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        if (sql[index + 1] === quote && quote !== "`") {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }
    if ((char === "-" && next === "-" && /\s/.test(sql[index + 2] || "")) || char === "#") {
      lineComment = true;
      if (char === "-") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function identifierList(value: string) {
  return value.split(",").map((item) => item.trim().replace(/^`|`$/g, "")).filter(Boolean);
}

function mysqlUnescape(value: string) {
  const replacements: Record<string, string> = {
    "0": "\0",
    b: "\b",
    n: "\n",
    r: "\r",
    t: "\t",
    Z: "\x1a",
    "\\": "\\",
    "'": "'",
    '"': '"'
  };
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      output += replacements[next] ?? next;
      index += 1;
    } else if ((char === "'" || char === '"') && value[index + 1] === char) {
      output += char;
      index += 1;
    } else {
      output += char;
    }
  }
  return output;
}

function parseMysqlValue(raw: string): MysqlDumpValue {
  const value = raw.trim();
  if (/^NULL$/i.test(value)) return null;
  if (/^TRUE$/i.test(value)) return true;
  if (/^FALSE$/i.test(value)) return false;
  if (/^0x[0-9a-f]*$/i.test(value)) return { hex: value.slice(2) };
  const hexString = value.match(/^[xX]'([0-9a-f]*)'$/);
  if (hexString) return { hex: hexString[1] };
  const bitString = value.match(/^[bB]'([01]+)'$/);
  if (bitString) return Number.parseInt(bitString[1], 2);
  const stringValue = value.match(/^(?:_binary\s*)?(['"])([\s\S]*)\1$/i);
  if (stringValue) return mysqlUnescape(stringValue[2]);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return value;
  throw new Error(`发现不支持的 MySQL 数据表达式：${value.slice(0, 80)}`);
}

function splitTupleValues(value: string) {
  const fields: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) {
        if (value[index + 1] === quote) {
          current += value[index + 1];
          index += 1;
        } else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map(parseMysqlValue);
}

function parseValueTuples(value: string) {
  const rows: MysqlDumpValue[][] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (index >= value.length) break;
    if (value[index] !== "(") throw new Error("INSERT VALUES 格式不正确");
    const start = index + 1;
    let depth = 1;
    let quote = "";
    let escaped = false;
    index += 1;
    while (index < value.length && depth > 0) {
      const char = value[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) {
          if (value[index + 1] === quote) index += 1;
          else quote = "";
        }
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    if (depth !== 0) throw new Error("INSERT 数据括号未闭合");
    rows.push(splitTupleValues(value.slice(start, index - 1)));
  }
  return rows;
}

function createTableColumns(statement: string) {
  const match = statement.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:`[^`]+`\.)?`?([A-Za-z0-9_]+)`?\s*\(([\s\S]*)\)(?:\s+[^)]*)?$/i);
  if (!match) return null;
  const columns: string[] = [];
  for (const line of match[2].split(/\r?\n/)) {
    const column = line.match(/^\s*`([^`]+)`\s+/);
    if (column) columns.push(column[1]);
  }
  return { table: match[1], columns };
}

function insertRows(statement: string, knownColumns: Map<string, string[]>) {
  const match = statement.match(/^(?:INSERT|REPLACE)\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\s+)*INTO\s+(?:`[^`]+`\.)?`?([A-Za-z0-9_]+)`?\s*(?:\(([^)]*)\))?\s+VALUES\s+([\s\S]+)$/i);
  if (!match) return null;
  const table = match[1];
  const columns = match[2] ? identifierList(match[2]) : knownColumns.get(table) || [];
  if (!columns.length) throw new Error(`无法确定数据表 ${table} 的字段顺序`);
  const rows = parseValueTuples(match[3]);
  if (rows.some((row) => row.length !== columns.length)) {
    throw new Error(`数据表 ${table} 的字段数量与 VALUES 不一致`);
  }
  return { table, columns, rows };
}

export function parseMysqlDump(sql: string, batchSize = 50): MysqlDumpPlan {
  const knownColumns = new Map<string, string[]>();
  const batches: MysqlDumpBatch[] = [];
  const tableRows: Record<string, number> = {};
  let ignoredStatements = 0;
  for (const statement of splitSqlStatements(sql.replace(/^\uFEFF/, ""))) {
    const tableDefinition = createTableColumns(statement);
    if (tableDefinition) {
      knownColumns.set(tableDefinition.table, tableDefinition.columns);
      continue;
    }
    const insert = insertRows(statement, knownColumns);
    if (!insert) {
      ignoredStatements += 1;
      continue;
    }
    tableRows[insert.table] = (tableRows[insert.table] || 0) + insert.rows.length;
    for (let index = 0; index < insert.rows.length; index += batchSize) {
      batches.push({
        table: insert.table,
        columns: insert.columns,
        rows: insert.rows.slice(index, index + batchSize)
      });
    }
  }
  const rowCount = Object.values(tableRows).reduce((sum, count) => sum + count, 0);
  if (!rowCount) throw new Error("文件中没有识别到可迁移的 INSERT 数据");
  return { batches, tableRows, rowCount, ignoredStatements };
}

export async function readMysqlDumpFile(file: File) {
  if (file.size > 500 * 1024 * 1024) throw new Error("MySQL 文件不能超过 500 MB");
  if (/\.sql\.gz$/i.test(file.name) || /gzip/i.test(file.type)) {
    if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持读取 gzip 文件，请先解压为 .sql");
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  if (!/\.sql$/i.test(file.name)) throw new Error("请选择 .sql 或 .sql.gz 文件");
  return file.text();
}

export async function sha256File(file: File) {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
