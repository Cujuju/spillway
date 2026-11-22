import { CLICKHOUSE_BASE64_WIRE, CLICKHOUSE_RAW_WIRE, CLICKHOUSE_RAW_WIRE_VERSION, CLICKHOUSE_WIRE_VERSION, RAW_PIECE_NAMESPACE } from '../src/main/clickhouseWire.ts';

export interface HistoryTables { facts: string; pieces: string }

const HISTORY_SETTINGS = "SETTINGS do_not_merge_across_partitions_select_final=1, join_use_nulls=0, join_default_strictness='ALL'";

export function pieceConflicts(pieces: string): string {
  return `WITH retries AS (
    SELECT source_id,seq FROM ${pieces} GROUP BY source_id,seq HAVING count()>1
  )
  SELECT count() AS conflicts FROM (
    SELECT source_id,seq FROM ${pieces}
    WHERE (source_id,seq) IN (SELECT source_id,seq FROM retries)
    GROUP BY source_id,seq
    HAVING min(tuple(thread_id,at,bytes))!=max(tuple(thread_id,at,bytes))
  )`;
}

export function historyQueries(tables: HistoryTables) {
  const common = `WITH
    source_facts AS (SELECT * FROM ${tables.facts} FINAL),
    source_pieces AS (SELECT * FROM ${tables.pieces} FINAL),
    candidates AS (
      SELECT *, request_pieces[1] AS ref, ref.piece_seq AS old_seq,
             bitOr(old_seq,toUInt64('${RAW_PIECE_NAMESPACE}')) AS new_seq,
             JSONExtractUInt(record_json,'rawBytes') AS raw_size
      FROM source_facts
      WHERE schema_version=${CLICKHOUSE_WIRE_VERSION} AND kind='capture-chunk' AND content_policy='included'
        AND arrayExists(piece -> piece.piece_seq>0 AND piece.piece_seq<{floors:Map(String, UInt64)}[source_id], request_pieces)
    ),
    decoded AS (
      SELECT c.*,p.seq AS found_seq,p.at AS piece_at,p.bytes AS stored,tryBase64Decode(p.bytes) AS wire_bytes
      FROM candidates AS c LEFT JOIN source_pieces AS p
        ON c.source_id=p.source_id AND c.thread_id=p.thread_id AND c.old_seq=p.seq
    ),
    moves AS (SELECT DISTINCT source_id,thread_id,old_seq,new_seq,piece_at,wire_bytes FROM decoded),
    changed_facts AS (SELECT source_id,at,seq FROM decoded),
    unchanged_refs AS (
      SELECT f.source_id AS source_id,ref.piece_seq AS seq
      FROM source_facts AS f ARRAY JOIN f.request_pieces AS ref
      WHERE (f.source_id,f.at,f.seq) NOT IN (SELECT source_id,at,seq FROM changed_facts)
    ),
    removed_low_pieces AS (
      SELECT source_id,old_seq FROM moves
      WHERE (source_id,old_seq) NOT IN (SELECT source_id,seq FROM unchanged_refs)
    ),
    new_raw_pieces AS (
      SELECT source_id,thread_id,new_seq AS seq,piece_at AS at,wire_bytes AS bytes
      FROM moves WHERE (source_id,new_seq) NOT IN (SELECT source_id,seq FROM source_pieces)
    )`;
  const expectedFacts = `SELECT * FROM source_facts
    WHERE (source_id,at,seq) NOT IN (SELECT source_id,at,seq FROM changed_facts)
    UNION ALL
    SELECT f.* REPLACE(
      toUInt16(${CLICKHOUSE_RAW_WIRE_VERSION}) AS schema_version,
      CAST([(d.new_seq,0,toUInt32(d.raw_size))] AS Array(Tuple(piece_seq UInt64, offset UInt32, length UInt32))) AS request_pieces,
      jsonMergePatch(f.record_json,'{"representation":"${CLICKHOUSE_RAW_WIRE}"}') AS record_json
    )
    FROM source_facts AS f INNER JOIN decoded AS d ON f.source_id=d.source_id AND f.at=d.at AND f.seq=d.seq`;
  const expectedPieces = `SELECT * FROM source_pieces
    WHERE (source_id,seq) NOT IN (SELECT source_id,old_seq FROM removed_low_pieces)
    UNION ALL SELECT * FROM new_raw_pieces`;
  const copy = (dest: string, expected: string) => `INSERT INTO ${dest} ${common} ${expected} ${HISTORY_SETTINGS}`;
  const verify = (dest: string, expected: string) => `${common},
    expected AS (${expected}),
    observed AS (SELECT * FROM ${dest} FINAL)
    SELECT
      (SELECT count() FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM observed)) +
      (SELECT count() FROM (SELECT * FROM observed EXCEPT ALL SELECT * FROM expected)) AS differences
    ${HISTORY_SETTINGS}`;
  const invalid = `
    length(request_pieces)!=1 OR found_seq=0 OR empty(thread_id)
    OR ref.offset!=0 OR length(stored)!=ref.length
    OR JSONExtractString(record_json,'representation')!='${CLICKHOUSE_BASE64_WIRE}'
    OR raw_size=0 OR length(wire_bytes)!=raw_size OR base64Encode(wire_bytes)!=stored`;
  return {
    invalidFacts: `${common} SELECT countIf(${invalid}) AS invalid FROM decoded ${HISTORY_SETTINGS}`,
    incompatibleRaw: `${common}
      SELECT count() AS conflicts FROM moves AS m LEFT JOIN source_pieces AS p
        ON m.source_id=p.source_id AND m.new_seq=p.seq
      WHERE p.seq!=0 AND (m.thread_id!=p.thread_id OR m.piece_at!=p.at OR m.wire_bytes!=p.bytes)
      ${HISTORY_SETTINGS}`,
    summary: `${common} SELECT
      (SELECT count() FROM changed_facts) AS convertedFacts,
      (SELECT count() FROM new_raw_pieces) AS newRawPieces,
      (SELECT count() FROM removed_low_pieces) AS reclaimableBase64Pieces
      ${HISTORY_SETTINGS}, output_format_json_quote_64bit_integers=1`,
    copyFacts: (dest: string) => copy(dest, expectedFacts),
    copyPieces: (dest: string) => copy(dest, expectedPieces),
    verifyFacts: (dest: string) => verify(dest, expectedFacts),
    verifyPieces: (dest: string) => verify(dest, expectedPieces),
  };
}
