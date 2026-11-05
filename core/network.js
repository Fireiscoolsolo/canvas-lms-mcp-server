// How the servers connect out: process-wide connection settings, and a stage-by-stage check of a host for `doctor`.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

// Node tries a host's addresses in turn and moves on after this long. Its default (250 ms on Node 20 and 22) can give
// up on a working address over slow Wi-Fi.
const ATTEMPT_MS = 1000;
// Node gives up on a new connection after 10 seconds, and that clock includes the DNS lookup. On some computers the
// system's lookup takes longer than that every time while the DNS server itself answers at once.
const DIRECT_AFTER_MS = 1000;
const SLOW_DNS_MS = 3000;
const nativeLookup = dns.lookup;

/** A name's addresses straight from the DNS servers, skipping the system's lookup. IPv4 first, IPv6 if there is none. */
async function askDnsServers(hostname, family) {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  const six = async () => (await resolver.resolve6(hostname)).map((address) => ({ address, family: 6 }));
  if (family === 6) return six();
  try {
    return (await resolver.resolve4(hostname)).map((address) => ({ address, family: 4 }));
  } catch (e) {
    if (family === 4) throw e;
    return six();
  }
}

/**
 * dns.lookup, except that a slow answer also gets the DNS servers asked directly, and the first answer wins. The system
 * goes first because it also knows the hosts file and VPN rules. A wrong address can't do harm: HTTPS still has to
 * prove it is the real host before anything is sent.
 */
export function patientLookup({ system = nativeLookup, direct = askDnsServers, waitMs = DIRECT_AFTER_MS, ipFamily = null } = {}) {
  return function lookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'number' ? { family: options } : { ...(typeof options === 'object' ? options : {}) };
    if (ipFamily) opts.family = ipFamily;
    let finished = false;
    const finish = (...answer) => { if (!finished) { finished = true; clearTimeout(timer); done(...answer); } };
    const timer = setTimeout(() => {
      direct(hostname, opts.family).then(
        (found) => (opts.all ? finish(null, found) : finish(null, found[0].address, found[0].family)),
        () => { /* the system's lookup is still running, so its answer decides */ },
      );
    }, waitMs);
    return system.call(dns, hostname, opts, finish);
  };
}

/**
 * Applies the connection settings to this process. Setting `ipFamily` to 4 or 6 asks DNS for that family only, which
 * also skips the other family's query.
 */
export function applyNetworkSettings({ ipFamily = null } = {}) {
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(ATTEMPT_MS);
  dns.lookup = patientLookup({ ipFamily });
}

function connectTo({ address, family }, { host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tcpMs = null;
    const socket = net.connect({ host: address, port, family, autoSelectFamily: false });
    const finish = (result) => { clearTimeout(timer); socket.destroy(); resolve({ address, tcpMs, ...result }); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
    socket.once('error', (e) => finish({ ok: false, error: e.code || e.message }));
    socket.once('connect', () => {
      tcpMs = Date.now() - started;
      const secure = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
      secure.once('error', (e) => finish({ ok: false, error: `TLS: ${e.code || e.message}` }));
      secure.once('secureConnect', () => { secure.destroy(); finish({ ok: true, totalMs: Date.now() - started }); });
    });
  });
}

/**
 * The Network part of `doctor`: says whether DNS and new connections to the school's Canvas are healthy. New connections
 * matter because reads can get by on ones already open, while a slow lookup or a blocked address breaks the next request.
 */
export async function reportConnections(base, { good, bad }, check = checkConnections) {
  const { hostname: host, port } = new URL(base);
  const { lookupMs, lookupError, directMs = null, results } = await check(host, { port: Number(port) || 443 });
  if (lookupError && directMs === null) { bad(`DNS couldn't find ${host} (${lookupError})`, 'Check your internet connection and the school address.'); return; }
  if (lookupError || lookupMs > SLOW_DNS_MS) {
    const what = lookupError ? `failed (${lookupError})` : `took ${(lookupMs / 1000).toFixed(1)} seconds`;
    bad(`This computer's DNS lookup for ${host} ${what}${directMs === null ? '' : `, but the DNS server answered in ${directMs} ms`}`, 'The Canvas server works around this, but other programs may be slow too. Check your DNS settings, any VPN and any network filtering software.');
  } else good(`DNS answered in ${lookupMs} ms (${results.length} address${results.length === 1 ? '' : 'es'})`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) bad(`Couldn't open a connection to ${failed.length} of ${results.length} addresses: ${failed.map((r) => `${r.address} (${r.error})`).join(', ')}`, 'Check for a VPN, proxy, firewall or antivirus web protection that treats Node.js differently from your browser.');
  else if (results.length) good(`Opened a new secure connection to ${results.length === 1 ? 'the address' : `all ${results.length} addresses`} (slowest ${Math.max(...results.map((r) => r.totalMs))} ms)`);
}

/** How long the system's DNS lookup and the DNS server each take for `host`, and whether a new secure connection opens to each address. */
export async function checkConnections(host, { port = 443, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  const direct = askDnsServers(host).then((found) => ({ found, ms: Date.now() - started }), () => null);
  let stop;
  const expired = new Promise((_, reject) => { stop = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs); });
  let addresses = null;
  let lookupError;
  try {
    addresses = await Promise.race([dns.promises.lookup(host, { all: true }), expired]);
  } catch (e) {
    lookupError = e.code || e.message;
  } finally {
    clearTimeout(stop);
  }
  const lookupMs = Date.now() - started;
  const answer = await direct;
  const usable = addresses || answer?.found || [];
  return { lookupMs, lookupError, directMs: answer?.ms ?? null, results: await Promise.all(usable.map((a) => connectTo(a, { host, port, timeoutMs }))) };
}
