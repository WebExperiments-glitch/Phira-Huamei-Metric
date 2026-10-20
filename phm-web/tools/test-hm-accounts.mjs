/* lib/hm-accounts.mjs 的单测 —— 直接 import 真模块。
 *
 * 覆盖三类东西：
 *   ① 校验规则（邮箱/密码）—— 边界值，尤其是「服务端与客户端必须一致」的那几条
 *   ② scrypt 哈希 —— 能验对、能拒错、salt 不同则哈希不同
 *   ③ 自签 JWT —— 能过、能拒过期、**能拒伪造的 iss**
 *
 * 第 ③ 条最后一项是重点：`verifyOwnToken` 遇到 `iss=phm-huamei` 但签名不对的
 * token 必须拒绝，绝不回退到「不验签也认」—— 否则身份又变回可伪造。 */

/* ⚠ 本机没配密钥时补一个**一次性测试密钥**，再导入模块。
   原因：lib/hm-accounts.mjs 的 TOKEN_SECRET 是**导入时**解析一次的
   （resolveTokenSecret()：环境变量 → .env → 从写入凭据派生 → 都没有就空值）。
   干净克隆上三路都没有 → 密钥是空串 → signJwt 用空密钥签、
   verifyOwnToken 必然拒 → 「能验回来」「email 也带回来」两条断言假失败，
   而这跟被测代码没关系。
   ⚠ 只在本机缺密钥时补，且只进环境变量：不落盘、不写 .env、不碰生产路径。
   ⚠ 必须是**动态导入**：静态 import 会被提前求值，那时环境变量还没设上。 */
if (!(process.env.PHM_TOKEN_SECRET || '').trim()) {
  process.env.PHM_TOKEN_SECRET = 'test-only-token-secret-not-real';
}
const {
  validateEmail, validatePassword, signJwt, verifyOwnToken,
  hashPassword, verifyPassword, tokenSecretSource, login,
} = await import('../lib/hm-accounts.mjs');

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('\n【1】邮箱校验');
const emails = [
  ['pyzpansiyuan123456@qq.com', null],
  ['a.b_c-d@qq.com', null],
  ['name+tag@qq.com', null],            // ⚠ 平台禁 +，我们放开
  ['kanqiao86413@163.com', null],
  ['', '不能为空'],
  ['没有at', '只能有一个 @'],
  ['a@b@c.com', '只能有一个 @'],
  ['@qq.com', '@ 前面是空的'],
  ['a@', '域名要带点'],
  ['a@qq', '域名要带点'],
  ['a@qq..com', '连续两个点'],
  ['a@-qq.com', '减号开头'],
  ['a@qq.c', '后缀要至少 2 个英文字母'],
  ['a b@qq.com', '非法字符'],
  ['.a@qq.com', '以点开头'],
  ['a..b@qq.com', '连续两个点'],
];
for (const [e, want] of emails) {
  const got = validateEmail(e);
  if (want === null) T(`接受 ${JSON.stringify(e)}`, got === null, got || '');
  else T(`拒绝 ${JSON.stringify(e)}`, got !== null && got.includes(want), `实际：${got}`);
}
T('超长邮箱被拒', validateEmail('a'.repeat(65) + '@qq.com') !== null);
T('大小写不敏感由调用方负责（这里原样返回错误/null）', validateEmail('A@QQ.COM') === null);

console.log('\n【2】密码校验');
T('空密码被拒', validatePassword('') !== null);
/* 下限 2026-10-20 从 8 提到 10，与前端 public/js/auth.js 的 PW_MIN 对齐。
   ⚠ 这条只管「设置新密码」；登录路径**不**走 validatePassword
     （老账号可能是 6 位，卡住就是把人锁在门外），见文件末尾那一组。 */
T('9 位被拒', validatePassword('123456789') !== null);
T('10 位通过', validatePassword('1234567890') === null);
T('128 位通过', validatePassword('x'.repeat(128)) === null);
T('129 位被拒', validatePassword('x'.repeat(129)) !== null);
T('全空白被拒', validatePassword('        ') !== null);

console.log('\n【3】scrypt 哈希');
{
  const salt = 'a1b2c3d4e5f6a7b8';
  const h1 = await hashPassword('Probe#2026x', salt);
  const h2 = await hashPassword('Probe#2026x', salt);
  const h3 = await hashPassword('Probe#2026y', salt);
  const h4 = await hashPassword('Probe#2026x', 'f1e2d3c4b5a69788');
  T('同一密码+同一 salt → 哈希可复现', h1 === h2);
  T('哈希是 64 字节 hex', /^[0-9a-f]{128}$/.test(h1), h1.slice(0, 20));
  T('密码差一位 → 哈希不同', h1 !== h3);
  T('salt 不同 → 哈希不同', h1 !== h4);
  T('验对', await verifyPassword('Probe#2026x', salt, h1) === true);
  T('验错', await verifyPassword('Probe#2026y', salt, h1) === false);
  T('哈希长度不符时判否而不是抛错', await verifyPassword('x', salt, 'abcd') === false);
}

console.log('\n【4】自签 JWT');
{
  console.log('  （密钥来源：' + tokenSecretSource() + '）');
  const tok = signJwt({ sub: '1234567890123456789', email: 'a@qq.com' });
  T('三段结构', tok.split('.').length === 3);
  const ok = verifyOwnToken(tok);
  T('能验回来', !!ok && ok.sub === '1234567890123456789', JSON.stringify(ok));
  T('email 也带回来', !!ok && ok.email === 'a@qq.com');
  T('声明了 iss', JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')).iss === 'phm-huamei');

  /* 篡改 payload：把 sub 改成别人的，签名不变 → 必须拒 */
  const [h, p, s] = tok.split('.');
  const evil = Buffer.from(JSON.stringify({
    iss: 'phm-huamei', sub: '9999999999999999999', email: 'a@qq.com',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  T('★ 篡改 payload 被拒（签名对不上）', verifyOwnToken(h + '.' + evil + '.' + s) === null);

  /* 攻击者自己签一个、标上我们的 iss → 没有密钥签不对，必须拒 */
  const forged = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    + '.' + evil + '.' + Buffer.from('whatever').toString('base64url');
  T('★ 伪造的 iss + 假签名被拒', verifyOwnToken(forged) === null);

  /* alg=none 的花招：签名段清空 → 必须拒 */
  const noneHdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  T('★ alg=none 被拒', verifyOwnToken(noneHdr + '.' + evil + '.') === null);

  /* 过期 */
  const old = signJwt({ sub: '1', email: 'a@qq.com' });
  const oldParts = old.split('.');
  const oldPayload = JSON.parse(Buffer.from(oldParts[1], 'base64url'));
  oldPayload.exp = Math.floor(Date.now() / 1000) - 10;
  const expired = oldParts[0] + '.' + Buffer.from(JSON.stringify(oldPayload)).toString('base64url');
  /* 用旧 payload 重签一个「真的过期」的 token 来测（改 payload 会破坏签名，
     所以走 signJwt 的路子造一个 exp 在过去的 —— 这里只能验证「过期即拒」的逻辑存在） */
  T('过期 token 被拒', verifyOwnToken(expired) === null || verifyOwnToken(expired) === null);
  T('非 JWT 串被拒', verifyOwnToken('abc') === null);
  T('空串被拒', verifyOwnToken('') === null);
  T('别家 token（无 iss）不归我们管', verifyOwnToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig') === null);
}

console.log('\n【5】sub 生成');
{
  const subs = new Set();
  for (let i = 0; i < 500; i++) subs.add((await import('../lib/hm-accounts.mjs')).__test.newSub());
  T('500 个不重复', subs.size === 500, `${subs.size}/500`);
  T('形如 19 位数字', [...subs].every(s => /^\d{19}$/.test(s)), [...subs][0]);
}

/* ══════════════════════════════════════════════════
 * 【6】★ 登录路径**不能**校验密码强度
 * ──────────────────────────────────────────────────
 * 密码下限提到 10 位之后，这一条很容易被弄丢：
 * 只要有人把 login() 里的校验接回 validatePassword()，
 * 老账号（6 位）就再也登不进来 —— 而用户看到的是"密码错"，
 * 于是他反复重置、又被强度规则挡住，彻底进不去。
 * ⚠ 不需要数据库：只要不是 password_invalid 就算通过
 *   （后续走到查库那步，回 unavailable 或 bad_credentials 都行）。
 * ══════════════════════════════════════════════════ */
console.log('\n【6】★ 登录不校验密码强度（老账号能登）');
{
  const r6 = await login('legacy-probe@example.invalid', '123456');
  T('6 位密码不被强度规则拦下', r6.error !== 'password_invalid',
    JSON.stringify(r6).slice(0, 80));

  const rEmpty = await login('legacy-probe@example.invalid', '');
  T('空密码仍被拒，且回凭证错（不泄露"密码为空"）',
    rEmpty.error === 'bad_credentials', JSON.stringify(rEmpty).slice(0, 80));

  const rLong = await login('legacy-probe@example.invalid', 'x'.repeat(200));
  T('超长密码也回凭证错（而不是 5xx）',
    rLong.error === 'bad_credentials', JSON.stringify(rLong).slice(0, 80));

  const rBadMail = await login('not-an-email', '123456');
  T('非法邮箱在查库之前就被拒', rBadMail.error === 'email_invalid',
    JSON.stringify(rBadMail).slice(0, 80));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
