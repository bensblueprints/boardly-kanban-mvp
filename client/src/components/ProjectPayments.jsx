import React, { useEffect, useState } from 'react';
import { CreditCard, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { fromMinor, toMinor } from '../money.mjs';

const emptyCard = () => ({ label: '', number: '', cardholder: '', exp_month: '', exp_year: '', billing: { line1: '', line2: '', city: '', region: '', postal_code: '', country: '' } });
const inputStyle = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-sm outline-none focus:border-indigo-400';
export default function ProjectPayments({ board }) {
  const owner=board.permissions?.owner!==false;
  const [data, setData] = useState(null), [currency, setCurrency] = useState('USD'), [budget, setBudget] = useState(''), [allow, setAllow] = useState(false);
  const [card, setCard] = useState(emptyCard), [adding, setAdding] = useState(false), [billing, setBilling] = useState({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [actuals, setActuals] = useState({});
  const base = `/api/boards/${board.id}/payments`;
  const load = async (settings = false) => {
    const result = await api.get(base); setData(result);
    if (settings) { setCurrency(result.currency); setBudget(fromMinor(result.budget_minor, result.currencies[result.currency])); setAllow(Boolean(result.allow_agent)); }
  };
  useEffect(() => { let active = true; api.get(base).then(result => { if (!active) return; setData(result); setCurrency(result.currency); setBudget(fromMinor(result.budget_minor, result.currencies[result.currency])); setAllow(Boolean(result.allow_agent)); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [board.id]);
  const act = async fn => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const money = (minor, code = data?.currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(minor / 10 ** (data?.currencies[code] ?? 2));
  const update = (key, value) => setCard(c => ({ ...c, [key]: value }));
  const address = (key, value) => setCard(c => ({ ...c, billing: { ...c.billing, [key]: value } }));
  const saveBudget = e => { e.preventDefault(); act(async () => { await api.put(base, { currency, budget_minor: toMinor(budget, data.currencies[currency]), allow_agent: allow }); await load(true); setNotice('Project budget and card access saved.'); }); };
  const saveCard = e => { e.preventDefault(); act(async () => { await api.post(`${base}/cards`, { ...card, exp_month: Number(card.exp_month), exp_year: Number(card.exp_year) }); setCard(emptyCard()); setAdding(false); setNotice('Card saved. Only its last four digits will be displayed.'); await load(); }); };
  return <div className="space-y-5">
    <div><h3 className="font-medium flex gap-2 items-center"><CreditCard size={18} />Project payment cards</h3><p className="text-sm text-zinc-400 mt-2">Manage the saved payment connections for this project. Card numbers stay encrypted and hidden. The account owner controls spending budgets and purchases.</p></div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
    {!data ? <p className="text-sm text-zinc-500">Loading payment settings…</p> : <>
      <div className="grid grid-cols-3 gap-2">{[['Recorded spent', data.spent_minor], ['Held for checkout', data.reserved_minor], ['Remaining budget', data.remaining_minor]].map(([label, value]) => <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><p className="text-xs text-zinc-500">{label}</p><p className={`mt-1 text-sm font-medium break-words ${value < 0 ? 'text-rose-300' : ''}`}>{money(value)}</p></div>)}</div>
      {owner&&<form onSubmit={saveBudget} className="rounded-xl border border-zinc-700 p-4 space-y-3">
        <h4 className="text-sm font-medium">Project spending budget</h4>
        <div className="grid grid-cols-3 gap-3"><label className="text-xs text-zinc-400">Currency<select aria-label="Budget currency" value={currency} onChange={e => setCurrency(e.target.value)} className={inputStyle + ' mt-1'}>{Object.keys(data.currencies).map(c => <option key={c}>{c}</option>)}</select></label><label className="col-span-2 text-xs text-zinc-400">Total project limit<input aria-label="Project spending limit" required inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} className={inputStyle + ' mt-1'} /></label></div>
        <p className="text-xs text-zinc-500">Lifetime budget shared by all cards in this project. Checkout requests above the remaining amount are blocked by Boardly. This does not change your bank’s card limit or cover purchases made outside Boardly.</p>
        <label className="flex gap-2 items-start text-sm text-zinc-300"><input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} className="mt-1" />Allow this project’s agent to use enabled cards for purchases I request, within this budget.</label>
        <button disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">Save spending settings</button>
      </form>}
      <div className="space-y-3"><div className="flex justify-between items-center"><h4 className="text-sm font-medium">Saved cards</h4><button disabled={busy} onClick={() => setAdding(!adding)} className="flex items-center gap-1 text-sm text-indigo-300"><Plus size={16} />{adding ? 'Close form' : 'Add payment card'}</button></div>
        {!data.cards.length && !adding && <p className="text-sm text-zinc-500">No payment cards assigned to this project.</p>}
        {data.cards.map(c => <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-2"><div className="flex items-center gap-3"><CreditCard size={22} className="text-zinc-500 shrink-0" /><div className="flex-1 min-w-0"><p className="text-sm truncate">{c.label}</p><p className="text-xs text-zinc-500">{c.brand} •••• {c.last4} · {String(c.exp_month).padStart(2,'0')}/{c.exp_year} · {c.enabled ? 'Enabled' : 'Paused'}</p></div><button disabled={busy} aria-label={`${c.enabled ? 'Pause' : 'Enable'} ${c.label}`} onClick={() => act(async () => { await api.patch(`${base}/cards/${c.id}`, { enabled: !c.enabled }); await load(); })} className="text-xs text-indigo-300">{c.enabled ? 'Pause' : 'Enable'}</button><button disabled={busy} aria-label={`Remove ${c.label}`} onClick={() => act(async () => { await api.del(`${base}/cards/${c.id}`); setBilling(b => { const next = { ...b }; delete next[c.id]; return next; }); await load(); })} className="text-zinc-500 hover:text-rose-300"><Trash2 size={16} /></button></div>
          <button disabled={busy} className="text-xs text-zinc-400" onClick={() => act(async () => { if (billing[c.id]) setBilling(b => ({ ...b, [c.id]: null })); else { const details = await api.get(`${base}/cards/${c.id}/billing`); setBilling(b => ({ ...b, [c.id]: details })); } })}>{billing[c.id] ? 'Hide billing details' : 'View billing details'}</button>
          {billing[c.id] && <p className="text-xs text-zinc-400 whitespace-pre-wrap">{[billing[c.id].cardholder, ...['line1','line2','city','region','postal_code','country'].map(k => billing[c.id].billing[k])].filter(Boolean).join('\n')}</p>}
        </div>)}
      </div>
      {adding && <form autoComplete="off" onSubmit={saveCard} className="rounded-xl border border-indigo-500/30 p-4 space-y-3">
        <h4 className="text-sm font-medium flex items-center gap-2"><LockKeyhole size={15} />Save a payment card</h4>
        <label className="block text-xs text-zinc-400">Card label<input aria-label="Payment card label" required maxLength={80} value={card.label} onChange={e => update('label', e.target.value)} className={inputStyle + ' mt-1'} placeholder="Project supplies" /></label>
        <label className="block text-xs text-zinc-400">Card number<input aria-label="Payment card number" type="password" inputMode="numeric" autoComplete="off" required maxLength={30} value={card.number} onChange={e => update('number', e.target.value)} className={inputStyle + ' mt-1'} /></label>
        <div className="grid grid-cols-2 gap-3"><label className="text-xs text-zinc-400">Expiry month<input aria-label="Card expiry month" type="number" min="1" max="12" required value={card.exp_month} onChange={e => update('exp_month',e.target.value)} className={inputStyle + ' mt-1'} placeholder="MM" /></label><label className="text-xs text-zinc-400">Expiry year<input aria-label="Card expiry year" type="number" min={new Date().getFullYear()} required value={card.exp_year} onChange={e => update('exp_year',e.target.value)} className={inputStyle + ' mt-1'} placeholder="YYYY" /></label></div>
        <label className="block text-xs text-zinc-400">Name on card<input aria-label="Name on card" required maxLength={120} value={card.cardholder} onChange={e => update('cardholder',e.target.value)} className={inputStyle + ' mt-1'} /></label>
        <div className="grid grid-cols-2 gap-3">{[['line1','Billing address',true],['line2','Address line 2',false],['city','City',true],['region','State or region',false],['postal_code','Postal code',false],['country','Country code',true]].map(([key,label,required]) => <label key={key} className="text-xs text-zinc-400">{label}<input aria-label={label} required={required} maxLength={key === 'country' ? 2 : 180} value={card.billing[key]} onChange={e => address(key,e.target.value)} className={inputStyle + ' mt-1'} placeholder={key === 'country' ? 'US, VN, TH…' : ''} /></label>)}</div>
        <p className="text-xs text-zinc-500">Security codes and PINs are not saved. If a checkout requires a security code or bank verification, you’ll need to complete that step.</p>
        <button disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save payment card'}</button>
      </form>}
      <div className="space-y-3"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">Checkout history</h4><button disabled={busy} className="text-xs text-indigo-300" onClick={() => act(() => load())}>Refresh history</button></div><p className="text-xs text-zinc-500">Amounts and outcomes are reported by the checkout agent or recorded by you. They are not a bank statement. Uncertain checkouts keep their budget hold until you resolve them.</p>
        {!data.purchases.length && <p className="text-sm text-zinc-500">No checkout requests yet.</p>}
        {data.purchases.map(p => <div key={p.id} className="rounded-xl border border-zinc-800 p-3 space-y-2"><div className="flex justify-between gap-3 text-sm"><span className="break-words">{p.description}</span><span className="shrink-0">{money(p.actual_minor ?? p.amount_minor, p.currency)}</span></div><p className="text-xs text-zinc-500 break-words">{p.merchant_origin} · •••• {p.card_last4} · {new Date(p.created_at).toLocaleString()}</p><p className={`text-xs ${['reserved','uncertain'].includes(p.status) ? 'text-amber-300' : 'text-zinc-400'}`}>{{reserved:'Awaiting checkout outcome · budget held',uncertain:'Needs review · budget held',paid:'Recorded as paid',released:'Confirmed no charge · budget released'}[p.status]}</p>
          {owner && ['reserved','uncertain'].includes(p.status) && <div className="flex flex-wrap gap-2"><input aria-label={`Actual payment for ${p.description}`} inputMode="decimal" placeholder="Actual paid amount" className={inputStyle + ' max-w-40'} value={actuals[p.id] ?? ''} onChange={e => setActuals(a => ({ ...a, [p.id]: e.target.value }))} /><button disabled={busy || !actuals[p.id]} className="text-xs text-indigo-300 disabled:opacity-40" onClick={() => act(async () => { await api.post(`${base}/purchases/${p.id}/resolve`, { status: 'paid', actual_minor: toMinor(actuals[p.id],data.currencies[p.currency]) }); await load(); })}>Record paid</button><button disabled={busy} className="text-xs text-zinc-400" onClick={() => act(async () => { await api.post(`${base}/purchases/${p.id}/resolve`, { status: 'released' }); await load(); })}>Confirm no charge</button></div>}
        </div>)}
      </div>
    </>}
  </div>;
}
