/* ============================================================
 * js/script-eval.js —— 不依赖 eval 的生成脚本解释器
 * ============================================================
 * 【为什么有这个文件】
 *   `chart_generate` 原本用 Function 构造 跑模型写的脚本。
 *   但站点 CSP 是 `script-src 'self' 'unsafe-inline'` —— **没有 'unsafe-eval'**，
 *   于是每一张谱都死在同一句话上：
 *       "Evaluating a string as JavaScript violates the following
 *        Content Security Policy directive"
 *   2026-10-25 实测：连错三次，模型最后自己猜到了这个原因。
 *
 *   ⚠ 我一开始用 DevTools 探 Function 构造 得到「可用」，那是**错的** ——
 *     DevTools 的 Runtime.evaluate 本身绕过 CSP，探不出页面的限制。
 *     判断 CSP 只能在页面自己的脚本里跑。
 *
 * 【为什么不是给 CSP 加 'unsafe-eval'】
 *   那是给整站开一个口子：任何一个 XSS 点都能从「注入一段脚本」升级成「任意求值」。
 *   这里跑的代码是模型生成的，更不该拥有这种权限。
 *
 * 【支持什么】
 *   够模型写出「第 40~48 拍每半拍一个 Tap，每 4 个换一次手」这类话就行：
 *     · 数字、局部变量、+ - * / % 与括号、一元负号
 *     · 比较 < <= > >= == != === !==，逻辑 && ||，一元 !
 *     · for (init; test; step) { }   （init/step 支持 = += -= ++）
 *     · if (cond) { } else { }
 *     · 函数调用，参数是表达式；Math.floor / Math.round / Math.abs / Math.min / Math.max
 *     · 注释 // # /* *\/，分号或换行分隔语句
 *   不支持：函数定义、对象字面量、字符串模板、while、数组方法。
 *   **不认识就直接抛错并指出第几行** —— 假装跑通比报错糟得多。
 * ============================================================ */

const MAX_STEPS = 200000;   /* 循环总步数上限，防止 `for(;;)` 卡死页面 */
const MAX_DEPTH = 24;

/* ── 词法 ── */
const PUNCT = ['===', '!==', '<=', '>=', '==', '!=', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '<', '>', '=', '+', '-', '*', '/', '%', '!',
  '?', ':', '(', ')', '{', '}', '[', ']', '.', ',', ';'];

function lex(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    /* 注释：三种都要吃，模型会混着写 */
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '`') {
      /* 模板字符串：支持 `${表达式}` 插值。
         ⚠ 以前把反引号当普通字符串，`${i}` 会被原样输出 —— **不报错、结果错**。
           模型很爱用它拼 report 文案，所以这里真解析。 */
      let j = i + 1, cur = '';
      const parts = [];
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { cur += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let k2 = j + 2, depth = 1;
          while (k2 < n && depth > 0) {
            if (src[k2] === '{') depth++;
            else if (src[k2] === '}') { depth--; if (!depth) break; }
            k2++;
          }
          if (depth) throw new SyntaxError(`第 ${line} 行：模板字符串里的 \${ 没有闭合`);
          parts.push({ s: cur });
          parts.push({ e: src.slice(j + 2, k2) });
          cur = '';
          j = k2 + 1;
          continue;
        }
        if (src[j] === '\n') line++;
        cur += src[j++];
      }
      if (j >= n) throw new SyntaxError(`第 ${line} 行：模板字符串没有闭合`);
      parts.push({ s: cur });
      out.push({ t: 'tpl', parts, line });
      i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      /* 字符串字面量。⚠ 模型一定会写 `report('前 8 拍')` ——
         连提示词里的范例都是这么写的，不支持就等于范例本身跑不通。 */
      const q = c;
      let j = i + 1, out2 = '';
      while (j < n && src[j] !== q) {
        if (src[j] === '\n') throw new SyntaxError(`第 ${line} 行：字符串没有闭合`);
        if (src[j] === '\\') {
          const nx = src[j + 1];
          out2 += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          j += 2; continue;
        }
        out2 += src[j++];
      }
      if (j >= n) throw new SyntaxError(`第 ${line} 行：字符串没有闭合`);
      out.push({ t: 'str', v: out2, line });
      i = j + 1; continue;
    }
    if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)), line });
      i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      /* ⚠ 标识符**不含点**：`sections[0].end` 这种「先下标再取成员」必须
         能解析，所以点交给后缀处理，不能一口吞进标识符里。 */
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j), line });
      i = j; continue;
    }
    let hit = null;
    for (const p of PUNCT) if (src.startsWith(p, i)) { hit = p; break; }
    if (!hit) throw new SyntaxError(`第 ${line} 行有不认识的字符「${c}」`);
    out.push({ t: 'p', v: hit, line });
    i += hit.length;
  }
  out.push({ t: 'eof', line });
  return out;
}

/* ── 语法（递归下降）── */
function parse(tokens) {
  let k = 0;
  const peek = () => tokens[k];
  const isP = (v) => tokens[k].t === 'p' && tokens[k].v === v;
  const take = (v) => {
    if (!isP(v)) throw new SyntaxError(`第 ${tokens[k].line} 行：这里应该是「${v}」，实际是「${tokens[k].v ?? '结尾'}」`);
    return tokens[k++];
  };
  const eat = (v) => { if (isP(v)) { k++; return true; } return false; };

  /* 三元 a ? b : c —— 模型很爱用，必须有 */
  function expr() {
    const c = or();
    if (isP('?')) {
      k++;
      const a = expr();
      take(':');
      const b = expr();
      return { k: 'cond', c, a, b };
    }
    return c;
  }
  function or() {
    let a = and();
    while (isP('||')) { k++; a = { k: 'bin', op: '||', a, b: and() }; }
    return a;
  }
  function and() {
    let a = cmp();
    while (isP('&&')) { k++; a = { k: 'bin', op: '&&', a, b: cmp() }; }
    return a;
  }
  function cmp() {
    let a = add();
    while (peek().t === 'p' && ['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(peek().v)) {
      const op = tokens[k++].v; a = { k: 'bin', op, a, b: add() };
    }
    return a;
  }
  function add() {
    let a = mul();
    while (isP('+') || isP('-')) { const op = tokens[k++].v; a = { k: 'bin', op, a, b: mul() }; }
    return a;
  }
  function mul() {
    let a = unary();
    while (isP('*') || isP('/') || isP('%')) { const op = tokens[k++].v; a = { k: 'bin', op, a, b: unary() }; }
    return a;
  }
  function unary() {
    if (isP('-')) { k++; return { k: 'neg', a: unary() }; }
    if (isP('!')) { k++; return { k: 'not', a: unary() }; }
    if (isP('+')) { k++; return unary(); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { k++; return postfix({ k: 'num', v: t.v }); }
    if (t.t === 'str') { k++; return postfix({ k: 'str', v: t.v }); }
    if (t.t === 'tpl') {
      k++;
      /* 插值在这里就解析成 AST —— 求值阶段不该再碰词法。 */
      const parts = t.parts.map((p) => (p.s !== undefined
        ? { s: p.s }
        : { e: parseSubExpression(p.e, t.line) }));
      return postfix({ k: 'tpl', parts });
    }
    if (t.t === 'id') { k++; return postfix({ k: 'id', name: t.v }); }
    if (isP('(')) { k++; const e = expr(); take(')'); return postfix(e); }
    /* 数组字面量：`const xs = [-300, 300];` 很常见，随手支持掉 */
    if (isP('[')) {
      k++;
      const items = [];
      if (!isP(']')) { do { items.push(expr()); } while (eat(',')); }
      take(']');
      return postfix({ k: 'arr', items });
    }
    /* 对象字面量：`{intro:[0,44.4], verse:[44.4,89]}` —— 模型拿它存段落表，
       拦掉的话每一轮都要白改一次。 */
    if (isP('{')) {
      k++;
      const pairs = [];
      if (!isP('}')) {
        do {
          const kt = peek();
          let keyNode;
          if (kt.t === 'id' || kt.t === 'str') { k++; keyNode = { k: 'str', v: kt.v }; }
          else if (kt.t === 'num') { k++; keyNode = { k: 'num', v: kt.v }; }
          else throw new SyntaxError(`第 ${kt.line} 行：对象的键必须是名字或字符串`);
          if (!isP(':')) throw new SyntaxError(`第 ${kt.line} 行：对象的键后面应该是「:」`);
          k++;
          pairs.push([keyNode, expr()]);
        } while (eat(','));
      }
      take('}');
      return postfix({ k: 'obj', pairs });
    }
    throw new SyntaxError(`第 ${t.line} 行：表达式里多了一个「${t.v ?? '结尾'}」`);
  }

  /* 后缀：.成员 / [下标] / (调用)。
     ⚠ 三个必须能在任意后缀组合里串起来：`sections[0].end`、`Math.floor(x)`、
       `beats[i]` —— 第一版只做了 `[下标]`，`sections[0].end` 直接报「不认识的字符 .」。 */
  function postfix(e) {
    for (;;) {
      if (isP('.') ) {
        k++;
        const t = peek();
        if (t.t !== 'id') throw new SyntaxError(`第 ${t.line} 行：「.」后面应该是属性名`);
        k++;
        e = { k: 'idx', obj: e, idx: { k: 'str', v: t.v } };
      } else if (isP('[')) {
        k++; const idx = expr(); take(']');
        e = { k: 'idx', obj: e, idx };
      } else if (isP('(')) {
        k++;
        const args = [];
        if (!isP(')')) { do { args.push(expr()); } while (eat(',')); }
        take(')');
        e = { k: 'call', callee: e, args };
      } else break;
    }
    return e;
  }

  function block() {
    take('{');
    const body = [];
    while (!isP('}')) {
      if (peek().t === 'eof') throw new SyntaxError('花括号没有闭合');
      body.push(stmt());
    }
    take('}');
    return body;
  }

  /* 体：带花括号就整块，不带就一条语句。
     ⚠ `if (b % 4 === 0) hold(b, b + 1);` 这种单语句写法极常见，
       第一版强制花括号，模型撞一次「这里应该是「{」」才改 —— 白烧一轮。 */
  function bodyOf() { return isP('{') ? block() : [stmt()]; }

  function stmt() {
    /* for */
    if (peek().t === 'id' && peek().v === 'for') {
      k++; take('(');
      let init = null;
      if (!isP(';')) {
        eatLet();
        init = simple();
      }
      take(';');
      let test = null;
      if (!isP(';')) test = expr();
      take(';');
      let step = null;
      if (!isP(')')) step = simple();
      take(')');
      return { k: 'for', init, test, step, body: bodyOf() };
    }
    /* if / else */
    if (peek().t === 'id' && peek().v === 'if') {
      k++; take('(');
      const test = expr();
      take(')');
      const cons = bodyOf();
      let alt = null;
      if (peek().t === 'id' && peek().v === 'else') { k++; alt = isP('if') ? [stmt()] : bodyOf(); }
      return { k: 'if', test, cons, alt };
    }
    if (isP(';')) { k++; return { k: 'nop' }; }
    eatLet();
    /* 一条语句里可以连写多个声明：`const B1 = 10, B2 = 20;`
       ⚠ 模型极爱这么写，不认它就整轮白改（实测一次任务里连撞 4 次）。 */
    const first = simple();
    if (!isP(',')) { eat(';'); return first; }
    const list = [first];
    while (eat(',')) list.push(simple());
    eat(';');
    return { k: 'seq', list };
  }

  /* let / var / const */
  function eatLet() {
    if (peek().t === 'id' && ['let', 'var', 'const'].includes(peek().v)) k++;
  }

  /* 赋值或调用 —— for 的 init/step 也走这里 */
  function simple() {
    const t = peek();
    if (t.t === 'id') {
      const nx = tokens[k + 1];
      const isAssign = nx && nx.t === 'p' && ['=', '+=', '-='].includes(nx.v);
      if (isAssign) {
        k += 2;
        return { k: 'assign', name: t.v, op: nx.v, value: expr() };
      }
      if (nx && nx.t === 'p' && ['++', '--'].includes(nx.v)) {
        k += 2;
        return { k: 'assign', name: t.v, op: nx.v === '++' ? '+=' : '-=', value: { k: 'num', v: 1 } };
      }
    }
    return { k: 'expr', e: expr() };
  }

  const body = [];
  while (peek().t !== 'eof') body.push(stmt());
  return body;
}

/** 只解析一条表达式（给模板字符串的 `${}` 用）。 */
function parseSubExpression(src, line) {
  let body;
  try { body = parse(lex(String(src))); }
  catch (e) { throw new SyntaxError(`第 ${line} 行：模板里的表达式有错 —— ${e.message}`); }
  if (body.length !== 1 || body[0].k !== 'expr') {
    throw new SyntaxError(`第 ${line} 行：模板里的 \${...} 只能放一条表达式`);
  }
  return body[0].e;
}

/* ── 求值 ──
   `host` = { 函数名: fn, 变量名: value }。只允许**白名单**里的名字。 */
function makeRunner(host) {
  const M = Math;
  /* `Math` 必须是一个**真正的对象**：标识符不再把点吞进名字里，
     `Math.floor` 现在是「取 Math 的 floor 成员再调用」。 */
  const MATH = Object.freeze({
    floor: M.floor, ceil: M.ceil, round: M.round, abs: M.abs,
    min: M.min, max: M.max, sqrt: M.sqrt, pow: M.pow,
    sin: M.sin, cos: M.cos, PI: M.PI,
  });
  /* ⚠ 这些属性一律取不到。CSP 本来就挡得住 `beats.constructor('…')` 这类
     绕道求值，但那是在赌一层配置；这里直接堵死更省心。 */
  const BANNED = new Set(['constructor', '__proto__', 'prototype', 'caller', 'arguments', 'bind', 'call', 'apply']);
  /* 无害的全局转换函数，模型常用 */
  const GLOBALS = Object.freeze({
    String, Number, Boolean, parseFloat, parseInt,
    isFinite, isNaN,
  });
  let steps = 0;

  function evalNode(node, scope) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'arr': return node.items.map((it) => evalNode(it, scope));
      case 'obj': {
        const o = {};
        for (const [kn, vn] of node.pairs) o[evalNode(kn, scope)] = evalNode(vn, scope);
        return o;
      }
      case 'tpl': return node.parts
        .map((p) => (p.s !== undefined ? p.s : String(evalNode(p.e, scope))))
        .join('');
      case 'id': {
        const name = node.name;
        if (name in scope) return scope[name];
        if (name === 'Math') return MATH;
        if (Object.hasOwn(GLOBALS, name)) return GLOBALS[name];
        if (Object.hasOwn(host, name)) return host[name];
        throw new Error(`脚本用了不存在的名字「${name}」`);
      }
      case 'idx': {
        const o = evalNode(node.obj, scope);
        const keyRaw = evalNode(node.idx, scope);
        const i = typeof keyRaw === 'string' ? keyRaw : num(keyRaw);
        if (o == null) throw new Error('对一个空值取属性/下标');
        if (BANNED.has(String(i))) throw new Error(`不允许取属性「${i}」`);
        const v = o[i];
        /* ⚠ 数字/字符串的方法必须**绑回原值**：`x.toFixed(2)` 取到的是
           `Number.prototype.toFixed`，不绑 this 调用就报
           "Number.prototype.toFixed requires that 'this' be a Number" ——
           模型完全看不懂这句话在说什么。 */
        if (typeof v === 'function' && (typeof o === 'number' || typeof o === 'string')) return v.bind(o);
        return v;
      }
      case 'neg': return -num(evalNode(node.a, scope));
      case 'not': return !truthy(evalNode(node.a, scope));
      case 'bin': {
        const op = node.op;
        if (op === '&&') return truthy(evalNode(node.a, scope)) ? evalNode(node.b, scope) : 0;
        if (op === '||') return truthy(evalNode(node.a, scope)) ? evalNode(node.a, scope) : evalNode(node.b, scope);
        const ra = evalNode(node.a, scope); const rb = evalNode(node.b, scope);
        /* 字符串拼接：`report('共 ' + n + ' 个')` 是模型的高频写法 */
        if (op === '+' && (typeof ra === 'string' || typeof rb === 'string')) return String(ra) + String(rb);
        const a = num(ra); const b = num(rb);
        switch (op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b === 0 ? 0 : a / b; case '%': return b === 0 ? 0 : a % b;
          case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
          case '==': case '===': return a === b;
          case '!=': case '!==': return a !== b;
          default: throw new Error('不支持的运算符 ' + op);
        }
      }
      case 'cond': return truthy(evalNode(node.c, scope)) ? evalNode(node.a, scope) : evalNode(node.b, scope);
      case 'call': {
        /* ⚠ 直接调名字时要报「不存在的函数」而不是「不存在的名字」——
           前者告诉模型「这里该有个函数」，后者让它以为变量名写错了。 */
        let f;
        if (node.callee.k === 'id') {
          const name = node.callee.name;
          if (name in scope) f = scope[name];
          else if (name === 'Math') f = MATH;
          else if (Object.hasOwn(GLOBALS, name)) f = GLOBALS[name];
          else if (Object.hasOwn(host, name)) f = host[name];
          else throw new Error(`脚本调用了不存在的函数「${name}」`);
        } else {
          f = evalNode(node.callee, scope);
        }
        if (typeof f !== 'function') {
          const label = node.callee.k === 'idx' && node.callee.idx.k === 'str' ? node.callee.idx.v : '(表达式)';
          throw new Error(`脚本调用了不存在的函数「${label}」`);
        }
        const args = node.args.map((a) => evalNode(a, scope));
        return f(...args);
      }
      default: throw new Error('解释器内部错误：' + node.k);
    }
  }

  function exec(list, scope, depth) {
    if (depth > MAX_DEPTH) throw new Error('脚本嵌套太深');
    for (const s of list) {
      if (++steps > MAX_STEPS) throw new Error(`脚本运行超过 ${MAX_STEPS} 步，可能有死循环`);
      switch (s.k) {
        case 'nop': break;
        case 'seq': exec(s.list, scope, depth + 1); break;
        case 'expr': evalNode(s.e, scope); break;
        case 'assign': {
          /* ⚠ 纯赋值**不能**做数值转换：`const xs = [-300, 300]` 被 num() 一转
             就成了 0，后面 `xs[0]` 全取到 undefined，而且不报错。
             只有 += / -= 才需要按数字算。 */
          if (s.op === '=') { scope[s.name] = evalNode(s.value, scope); break; }
          const cur = num(scope[s.name] ?? 0);
          const v = num(evalNode(s.value, scope));
          scope[s.name] = s.op === '+=' || s.op === '++' ? cur + v : cur - v;
          break;
        }
        case 'if': exec(truthy(evalNode(s.test, scope)) ? s.cons : (s.alt || []), scope, depth + 1); break;
        case 'for': {
          /* ⚠ 不另开作用域：`let n = 0` 在循环外、循环里 `n += 1`，
             在 JS 里改的是**外层那个 n**。第一版用 Object.create(scope) 隔了一层，
             结果循环外的 n 一直是 0 —— report('共 ' + n) 打出「共 0 个音符」，
             **不报错、只是数字错**，这一类最难发现。宁可让循环变量泄漏到外层。 */
          const sc = scope;
          if (s.init) exec([s.init], sc, depth + 1);
          for (;;) {
            if (++steps > MAX_STEPS) throw new Error(`循环超过 ${MAX_STEPS} 步，检查 for 的终止条件`);
            if (s.test && !truthy(evalNode(s.test, sc))) break;
            exec(s.body, sc, depth + 1);
            if (s.step) exec([s.step], sc, depth + 1);
          }
          break;
        }
        default: throw new Error('解释器内部错误：' + s.k);
      }
    }
  }

  return (src) => {
    steps = 0;
    const ast = parse(lex(String(src ?? '')));
    exec(ast, Object.create(null), 0);
    return steps;
  };
}

const num = (v) => (typeof v === 'number' ? v : (v === true ? 1 : v === false || v == null ? 0 : Number(v) || 0));
const truthy = (v) => (typeof v === 'number' ? v !== 0 : Boolean(v));

/**
 * 跑一段生成脚本。
 * @param {string} src 脚本源码
 * @param {Record<string, any>} host 允许脚本看到的函数与变量（白名单）
 * @returns {{ steps: number }}
 */
export function runScript(src, host) {
  if (!String(src || '').trim()) throw new Error('脚本是空的');
  return { steps: makeRunner(host)(src) };
}
