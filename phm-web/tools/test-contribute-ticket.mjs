/* 贡献凭证单元测试（不联网）。
 *
 * 覆盖 /api/contribute 新认证门的核心不变量：
 *   签发 → 验签；跨 IP 拒绝；篡改签名/载荷拒绝；chart_id 覆盖检查。
 *
 * 跑法： node tools/test-contribute-ticket.mjs
 */
import {
  ticketAvailable, issueTicket, verifyTicket, ticketCovers, TICKET_MAX_CHARTS,
} from '../lib/contribute-ticket.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
};

if (!ticketAvailable()) {
  console.log('⚠ 没有 WRITE_SECRET，凭证功能 fail-closed —— 跳过（这是预期行为）');
  process.exit(0);
}

const IP = '203.0.113.7';
const { ticket, cids } = issueTicket([3, 4, 4, 5], { ip: IP });
T('签发：chart_id 去重', JSON.stringify(cids) === '[3,4,5]', JSON.stringify(cids));
T('签发：格式 v1.<payload>.<sig>', /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket));

const ok = verifyTicket(ticket, { ip: IP });
T('验签：同 IP 通过', ok.ok === true, JSON.stringify(ok));
T('验签：cids 正确', ok.ok && JSON.stringify(ok.cids) === '[3,4,5]', JSON.stringify(ok));

const wrongIp = verifyTicket(ticket, { ip: '198.51.100.9' });
T('跨 IP 拒绝', wrongIp.ok === false && wrongIp.error === 'ticket_ip_mismatch', JSON.stringify(wrongIp));

const missing = verifyTicket('', { ip: IP });
T('空票拒绝', missing.ok === false && missing.error === 'ticket_missing');

const [v, body, sig] = ticket.split('.');
const tampered = verifyTicket(v + '.' + body + '.' + sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA'), { ip: IP });
T('篡改签名拒绝', tampered.ok === false && tampered.error === 'ticket_invalid', JSON.stringify(tampered));

/* 换 payload 但保留旧签名 —— 必须失败（否则可以自己扩 chart_id） */
const evilBody = Buffer.from(JSON.stringify({ v: 1, cids: [3, 4, 5, 999999], ip: JSON.parse(Buffer.from(body, 'base64url').toString()).ip, exp: Date.now() + 60000 })).toString('base64url');
const evil = verifyTicket(v + '.' + evilBody + '.' + sig, { ip: IP });
T('篡改载荷拒绝', evil.ok === false && evil.error === 'ticket_invalid', JSON.stringify(evil));

T('覆盖检查：子集通过', ticketCovers(ok.cids, [3, 5]) === true);
T('覆盖检查：未授权 id 拒绝', ticketCovers(ok.cids, [3, 999999]) === false);

const many = issueTicket([1, 2, 3, 4, 5, 6, 7, 8], { ip: IP });
T('单票 chart 数封顶 ' + TICKET_MAX_CHARTS, many.cids.length === TICKET_MAX_CHARTS, String(many.cids.length));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
