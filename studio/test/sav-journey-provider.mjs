/** Loaded only by the clean, loopback Playwright harness. No real provider traffic. */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const studio = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.env.NODE_ENV === 'production' || process.env.SAV_JOURNEY_E2E !== 'synthetic-loopback-only'
  || process.env.DATABASE_URL !== `pglite://${path.join(studio, '.e2e-journey-db')}`
  || process.env.HUBSPOT_ACCESS_TOKEN !== 'synthetic-journey-only') throw new Error('JOURNEY_PROVIDER_ISOLATION_REFUSED');
const statePath = path.join(studio, '.e2e-journey-provider.json');
const network = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '3118') { url.hostname = '127.0.0.1'; return network(input instanceof Request ? new Request(url, input) : url, init); }
  if (url.hostname === 'registry.npmjs.org' && url.pathname === '/-/package/next/dist-tags') return Response.json({ latest: '16.3.8' });
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') return Response.json({ access_token: 'synthetic-only', expires_in: 3600 });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : null;
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  const stages = ['1', '2', '3', '4'].map(id => ({ id, metadata: { isClosed: id === '4', ticketState: id === '4' ? 'CLOSED' : 'OPEN' } }));
  if (url.hostname === 'gmail.googleapis.com') {
    const threadName = url.pathname.split('/threads/')[1];
    if (threadName) {
      const key = threadName.replace('journey-', ''), entry = state.cases[key];
      return Response.json({ messages: [{ id: `journey-message-${key}`, internalDate: String(Date.parse(entry.receivedAt)), labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: entry.email }] } }] });
    }
    if (url.pathname.endsWith('/messages/send') && method === 'POST') {
      state.events.push({ kind: 'send', threadId: body.threadId, raw: body.raw }); save();
      return Response.json({ id: `synthetic-sent-${body.threadId}`, threadId: body.threadId });
    }
    if (url.pathname.endsWith('/messages') && method === 'GET') return Response.json({ messages: [] });
  }
  if (url.hostname === 'api.hubapi.com') {
    const route = url.pathname;
    if (route.endsWith('/pipelines/tickets/0')) return Response.json({ id: '0', stages });
    if (route.endsWith('/pipelines/tickets')) return Response.json({ results: [{ id: '0', stages }] });
    if (route === '/crm/v3/owners') return Response.json({ results: [{ id: '999201', firstName: 'Support', lastName: 'Fictif' }] });
    if (route.endsWith('/contacts/search')) {
      const email = body.filterGroups?.[0]?.filters?.[0]?.value ?? body.query;
      const entry = Object.values(state.cases).find(c => c.email === email);
      return Response.json({ results: entry?.contactId ? [{ id: entry.contactId, properties: { email, firstname: 'Client', lastname: 'Fictif' } }] : [] });
    }
    if (route.endsWith('/tickets/search')) {
      const contactId = body.filterGroups[0].filters[0].value;
      return Response.json({ results: Object.values(state.tickets).filter(t => t.associations.contacts.results.some(c => c.id === contactId)) });
    }
    if (/\/tickets\/\d+\/associations\/(notes|emails)$/.test(route)) return Response.json({ results: [] });
    if (route.endsWith('/associations/notes/tickets/labels')) return Response.json({ results: [{ category: 'HUBSPOT_DEFINED', label: null, typeId: 228 }] });
    const ticketId = route.match(/\/objects\/tickets\/(\d+)$/)?.[1];
    const noteId = route.match(/\/objects\/notes\/(\d+)$/)?.[1];
    if (ticketId && method === 'GET') return state.tickets[ticketId] ? Response.json(state.tickets[ticketId]) : Response.json({}, { status: 404 });
    if (noteId && method === 'GET') return state.notes[noteId] ? Response.json(state.notes[noteId]) : Response.json({}, { status: 404 });
    if (route.endsWith('/objects/notes') && method === 'POST') {
      const target = body.associations[0].to.id;
      const entry = Object.values(state.cases).find(c => c.ticketId === target);
      state.events.push({ kind: 'note_attempt', ticketId: target });
      if (entry.fault === '403') { save(); return Response.json({}, { status: 403 }); }
      const id = String(800000 + Object.keys(state.notes).length);
      state.notes[id] = { id, properties: body.properties, createdAt: new Date().toISOString(), associations: { tickets: { results: [{ id: target }] } } };
      state.events.push({ kind: 'note', ticketId: target, id }); save(); return Response.json(state.notes[id]);
    }
    if (ticketId && method === 'PATCH') {
      Object.assign(state.tickets[ticketId].properties, body.properties);
      state.events.push({ kind: 'patch', ticketId }); save();
      if (Object.values(state.cases).find(c => c.ticketId === ticketId)?.fault === 'timeout') throw new TypeError('Synthetic lost acknowledgement');
      return Response.json(state.tickets[ticketId]);
    }
    if (route.endsWith('/objects/tickets') && method === 'POST') {
      const id = String(900000 + Object.keys(state.tickets).length);
      state.tickets[id] = { id, properties: body.properties, createdAt: new Date().toISOString(), associations: { contacts: { results: [{ id: body.associations[0].to.id }] } } };
      state.events.push({ kind: 'create', ticketId: id, contactId: body.associations[0].to.id }); save(); return Response.json(state.tickets[id]);
    }
  }
  appendFileSync(path.join(studio, '.e2e-journey-blocked.log'), `${method} ${url.origin}${url.pathname}\n`);
  throw new Error('JOURNEY_UNEXPECTED_NETWORK_BLOCKED');
};
