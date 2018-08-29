import {
  is_string,
  is_function,
  flatten,
  flatten as cat,
  reduce,
  tap,
  go,
  map,
  filter,
  reject,
  pluck,
  uniq,
  each,
  index_by,
  group_by,
  last
} from 'fxjs2';
import { Pool } from 'pg';
import { dump as DUMP } from 'dumper.js';
function dump(){}dump = DUMP;
const table_columns = {};
const SymbolColumn = Symbol('COLUMN');
const SymbolTag = Symbol('TAG');
const SymbolInjection = Symbol('INJECTION');
const SymbolDefault = Symbol('DEFAULT');

const wrap_arr = a => Array.isArray(a) ? a : [a];
const mix = (arr1, arr2) => arr1.reduce((res, item, i) => {
  res.push(item);
  i < arr2.length && res.push(arr2[i]);
  return res;
}, []);

const initial = function (ary, n, guard) {
  return Array.prototype.slice.call(ary, 0, Math.max(0, ary.length - (n == null || guard ? 1 : n)));
};

const add_column = me =>
  me.column == '*' ?
    COLUMN(me.table + '.*') :
    COLUMN(...go(
      me.column.originals.concat(pluck('left_key', me.rels)),
      map(c => me.table + '.' + c),
      uniq));

const add_as_join = (me, as) =>
  COLUMN(...go(
      me.column.originals.concat(pluck('left_key', me.outer_joins)),
      map(c => me.as + '.' + c + ' AS ' + `${as}>_<${c}`),
      uniq
    ));


const to_qq = () => '??';
const escape_dq = value => ('' + value).replace(/\\/g, "\\\\").replace(/"/g, '""');
const dq = str => str.split('.').map(s => s == '*' ? s : `"${escape_dq(s)}"`).join(".");
const columnize = v =>
  v == '*' ?
    '*' :
    v.match(/\s*\sas\s\s*/i) ?
      v.split(/\s*\sas\s\s*/i).map(dq).join(' AS ') :
      dq(v);

const is_column = f => f && f[SymbolColumn];
const is_tag = f => f && f[SymbolTag];
const is_injection = query => query == SymbolInjection;

function ready_sqls(strs, tails) {
  const options = strs
      .map(s => s
        .replace(/\s*\n/, '')
        .split('\n')
        .map((s) => {
          var depth = s.match(/^\s*/)[0].length,
            as = s.trim(),
            rel_type;

          var prefix = as.substr(0, 2);
          if (['- ', '< ', 'x '].includes(prefix)) {
            rel_type = prefix.trim();
            as = as.substr(1).trim();
            return { depth, as, rel_type }
          } else if (prefix == 'p ') {
            rel_type = as[3];
            as = as.substr(3).trim();
            return { depth, as, rel_type, is_poly: true }
          } else {
            return { depth, as };
          }
        })
      );

    go(
      tails,
      map(tail =>
        is_string(tail) ?
          { query: tag({ text: tail }) } :
          is_function(tail) ?
            { query: tail } :
            Object.assign(tail, { query: tail.query || tag({ text: '' }) })
      ),
      Object.entries,
      each(([i, t]) => go(
        options[i],
        last,
        _ => Object.assign(_, t)
      ))
    );

    return options;
}

function replace_qq(query) {
  if (is_injection(query)) return SymbolInjection;

  let i = 0;
  query.text = query.text.replace(/\?\?/g, _ => `$${++i}`);
  return query;
}

function merge_query(queries) {
  if (queries.find(is_injection)) return SymbolInjection;

  var query = reduce((res, query) => {
    if (!query) return res;
    if (query.text) res.text += query.text;
    if (query.values) res.values.push(...query.values);
    return res;
  }, queries, {
    text: '',
    values: []
  });
  query.text = query.text.replace(/\n/g, ' ').replace(/\s\s*/g, ' ').trim();
  return query;
}

export function VALUES(values) {
  return tag(function () {
    values = Array.isArray(values) ? values : [values];

    const columns = go(
      values,
      map(Object.keys),
      flatten,
      uniq);

    const DEFAULTS = go(
      columns,
      map(k => [k, SymbolDefault]),
      object);

    values = values
      .map(v => Object.assign({}, DEFAULTS, v))
      .map(v => Object.values(v));

    return {
      text: `
          (${COLUMN(...columns)().text}) 
        VALUES 
          (${
          values
            .map(v => v.map(v => v == SymbolDefault ? 'DEFAULT' : to_qq()).join(', '))
            .join('), (')})`,
      values: flatten(values.map(v => v.filter(v => v != SymbolDefault)))
    }
  });
}

function tag(f) {
  return typeof f == 'function' ?
    Object.assign(f, { [SymbolTag]: true }) : tag(function() { return f; });
}

export function COLUMN(...originals) {
  return Object.assign(tag(function() {
    return {
      text: originals
        .map(v =>
          is_string(v) ?
            columnize(v)
          :
            Object
              .entries(v)
              .map(v => v.map(dq).join(' AS '))
              .join(', '))
        .join(', ')
    };
  }), { [SymbolColumn]: true, originals: originals });
}

export const CL = COLUMN,
  TABLE = COLUMN,
  TB = TABLE;

function PARAMS(obj, sep) {
  return tag(function() {
    let i = 0;
    const text = Object.keys(obj).map(k => `${columnize(k)} = ${to_qq()}`).join(sep);
    const values = Object.values(obj);
    return {
      text: text.replace(/\?\?/g, function() {
        const value = values[i++];
        return is_column(value) ? value().text : to_qq()
      }),
      values: reject(is_column, values)
    };
  });
}

export function EQ(obj, sep = 'AND') {
  return PARAMS(obj, ' ' + sep + ' ');
}

export function SET(obj) {
  return tag(function() {
    const query = PARAMS(obj, ', ')();
    query.text = 'SET ' + query.text;
    return query;
  });
}

function BASE_IN(key, operator, values) {
  values = uniq(values);

  var keys_text = COLUMN(...wrap_arr(key))().text;
  return {
    text: `${Array.isArray(key) ? `(${keys_text})` : keys_text} ${operator} (${values.map(
      Array.isArray(key) ? v => `(${v.map(to_qq).join(', ')})` : to_qq
    ).join(', ')})`,
    values: cat(values)
  };
}

export function IN(key, values) {
  return tag(function() {
    return BASE_IN(key, 'IN', values);
  });
}

export function NOT_IN(key, values) {
  return tag(function() {
    return BASE_IN(key, 'NOT IN', values);
  });
}

function _SQL(texts, values) {
  return go(
    mix(
      texts.map(text => ({ text })),
      values.map(value =>
        is_tag(value) ? value() : is_function(value) ? SymbolInjection : { text: to_qq(), values: [value] })
    ),
    merge_query);
}

export function SQL(texts, ...values) {
  return tag(function() {
    return _SQL(texts, values);
  });
}

function baseAssociate(QUERY) {
  return async function(strs, ...tails) {
    return go(
      ready_sqls(strs, tails),
      cat,
      filter(t => t.as),
      each(option => {
        option.column = option.column || '*';
        option.query = option.query || tag();
        option.table = option.table || (option.rel_type == '-' ? option.as + 's' : option.as);
        option.rels = [];
      }),
      function setting([left, ...rest]) {
        const cur = [left];
        each(me => {
          while (!(last(cur).depth < me.depth)) cur.pop();
          const left = last(cur);
          left.rels.push(me);
          if (me.rel_type == '-') {
            me.left_key = me.left_key || (me.is_poly ? 'id' : me.table.substr(0, me.table.length-1) + '_id');
            me.key = me.key || (me.is_poly ? 'attached_id' : 'id');
          } else {
            me.left_key = me.left_key || 'id';
            me.key = me.key || (me.is_poly ? 'attached_id' : left.table.substr(0, left.table.length-1) + '_id');
          }

          if (me.rel_type == 'x') {
            var table2 = me.xtable || (left.table + '_' + me.table);
            me.join = SQL `INNER JOIN ${TB(table2)} on ${EQ({
              [table2 + '.' + me.table.substr(0, me.table.length-1) + '_id']: COLUMN(me.table + '.id')  
            })}`;
            me.key = table2 + '.' + me.key;
          } else {
            me.join = tag();
          }

          me.poly_type = me.is_poly ?
            SQL `AND ${EQ(
              is_string(me.poly_type) ? { attached_type: me.poly_type || left.table } : me.poly_type
            )}` : tag();
          cur.push(me);
        }, rest);
        return left;
      },
      async function(me) {
        const lefts = await QUERY `
          SELECT ${add_column(me)}
            FROM ${TB(me.table)} ${me.query}`;

        return go(
          [lefts, me],
          function recur([lefts, option]) {
            return option.rels.length && go(option.rels, each(async function(me) {
              const query = me.query();
              if (query && query.text) query.text = query.text.replace(/WHERE/i, 'AND');

              var fold_key = me.rel_type == 'x' ?
                `_#_${me.key.split('.')[1]}_#_` : me.key;

              var colums = uniq(add_column(me).originals.concat(me.key + (me.rel_type == 'x' ? ` AS ${fold_key}` : '')));

              const rights = await QUERY `
                SELECT ${COLUMN(...colums)}
                  FROM ${TB(me.table)}
                  ${me.join} 
                  WHERE 
                    ${IN(me.key, pluck(me.left_key, lefts))}
                    ${me.poly_type}
                    ${tag(query)}`;

              var [folder, default_value] = me.rel_type == '-' ?
                [index_by, () => {}] : [group_by, () => []];

              return go(
                rights,
                folder(a => a[fold_key]),
                folded => each(function(left) {
                  left._ = left._ || {};
                  left._[me.as] =
                    folded[left[me.left_key]] ||
                    default_value();
                }, lefts),
                () => recur([rights, me]));
            }));
          },
          _ => lefts
        );
      }
    );
  }
}

function ljoin(QUERY) {
  return async function(strs, ...tails) {
    return go(
      ready_sqls(strs, tails),
      cat,
      filter(t => t.as),
      each(option => {
        option.query = option.query || tag();
        option.table = option.table || (option.rel_type == '-' ? option.as + 's' : option.as);
        option.column = option.column || CL(...table_columns[option.table]);
        option.outer_joins = [];
        option.rels = [];
      }),
      function setting([left, ...rest]) {
        const cur = [left];
        each(me => {
          while (!(last(cur).depth < me.depth)) cur.pop();
          const left = last(cur);
           if (me.rel_type == '-') {
            me.left_key = me.left_key || (me.is_poly ? 'id' : me.table.substr(0, me.table.length-1) + '_id');
            me.key = me.key || (me.is_poly ? 'attached_id' : 'id');
            left.outer_joins.push(me);
          } else {
            me.left_key = me.left_key || 'id';
            me.key = me.key || (me.is_poly ? 'attached_id' : left.table.substr(0, left.table.length-1) + '_id');
            left.rels.push(me);
            // if (me.rel_type == 'x') {
            //   var table2 = me.xtable || (left.table + '_' + me.table);
            //   me.join = SQL `INNER JOIN ${TB(table2)} on ${EQ({
            //     [table2 + '.' + me.table.substr(0, me.table.length-1) + '_id']: COLUMN(me.table + '.id')
            //   })}`;
            //   me.key = table2 + '.' + me.key;
            // } else {
            //   me.join = tag();
            // }
          }
          cur.push(me);
        }, rest);
        return left;
      },
      async function(me) {
        return left_outer_join_sql(me, null, QUERY);
      }
    );
  };

}

function make_join_group(join_group, outer_joins) {
  return each(join_right => {
    // console.log(add_as_join(join_right)())
    join_group.push(join_right);
    make_join_group(join_group, join_right.outer_joins);
  }, outer_joins)
}

function left_outer_join_sql(left, where_in_query, QUERY) {
  const join_columns = [];
  const join_sqls = [];
  join_columns.push(add_as_join(left, left.as).originals);
  return go(
    left,
    function recur(me, parent_as) {
      parent_as = parent_as || me.as;
      each(right => {
        const query = right.query();
        if (query && query.text) query.text = query.text.replace(/WHERE/i, 'AND');
        join_columns.push(
          uniq(add_as_join(right, `${parent_as}>_<${right.as}`).originals.concat(right.as + '.' + right.key + ' AS ' + `${right.as}>_<${right.key}`))
        );
        join_sqls.push(SQL `
        LEFT JOIN
         ${TB(right.table)} AS ${TB(right.as)}
          ON
          ${EQ({
            [me.as + '.' + right.left_key]: COLUMN(right.as + '.id') 
          })}
          ${tag(query)}
        `());
        recur(right, `${parent_as}>_<${right.as}`);
      }, me.outer_joins);
    },
    () => QUERY `
      SELECT ${COLUMN(...cat(join_columns))}
      FROM ${TB(left.table)} AS ${TB(left.as)}
      ${SQL(pluck('text', join_sqls).join(' ').split('??'), ...cat(pluck('values', join_sqls)))}
      ${left.query}`,
    map(function(row) {
      const result_obj = {};
      let first_as = '';
      for (const as in row) {
        if (as.indexOf('>_<') == -1) return ;
        const split_as = as.split('>_<');
        const ass = initial(split_as);
        if (!first_as) first_as = ass[0];
        let _obj = null;
        reduce(function(mem, key) {
          _obj = mem[key] = mem[key] || { _: {}};
          return mem[key]._;
        }, ass, result_obj);
        _obj[split_as[split_as.length-1]] = row[as];
      }
      return result_obj[first_as];
    })
  )
}

export async function CONNECT(connection) {
  const pool = new Pool(connection);
  const pool_query = pool.query.bind(pool);

  function base_query(excute_query, texts, values) {
    return go(
      _SQL(texts, values),
      replace_qq,
      query => is_injection(query) ? Promise.reject('INJECTION ERROR') : query,
      tap(function(query) {
        if (global.MQL_DEBUG) console.log(query);
      }),
      excute_query,
      res => res.rows);
  }

  async function QUERY(texts, ...values) {
    return base_query(pool_query, texts, values);
  }
  Object.assign(table_columns, await go(QUERY `select table_name, column_name from information_schema.columns where table_name in (select tablename from pg_tables where tableowner='mpress' order by tablename);`,
    group_by((v) => v.table_name),
    map(v => pluck('column_name', v))
  ));
  return {
    VALUES,
    IN,
    NOT_IN,
    EQ,
    SET,
    COLUMN,
    CL,
    TABLE,
    TB,
    SQL,

    QUERY,

    LJOIN: ljoin(QUERY),

    ASSOCIATE: baseAssociate(QUERY),

    async TRANSACTION() {
      const client = await pool.connect();
      const client_query = client.query.bind(client);
      await client.query('BEGIN');
      function QUERY_T(texts, ...values) {
        return base_query(client_query, texts, values);
      }
      return {
        QUERY_T,
        async COMMIT() {
          await client.query('COMMIT');
          return await client.release();
        },
        async ROLLBACK() {
          await client.query('ROLLBACK');
          return await client.release();
        },
        ASSOCIATE_T: baseAssociate(QUERY)
      }
    }
  }
}