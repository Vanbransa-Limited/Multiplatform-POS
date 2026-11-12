"use client";

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { platformClient } from '@/services/platform-client';
import './platform.css';

type Tenant = { tenantId: string; businessName: string; slug: string; ownerEmail: string; status: string; logoUrl?: string };
const empty = { businessName: '', slug: '', branchName: '', ownerName: '', ownerEmail: '', ownerPassword: '', logoUrl: '' };

export default function PlatformPage() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [form, setForm] = useState(empty);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [created, setCreated] = useState<Tenant | null>(null);
  const request = useRef<{ id: string; payload: string } | null>(null);

  async function loadTenants() {
    const response = await httpsCallable<unknown, { tenants: Tenant[] }>(platformClient().functions, 'listPlatformTenants')({});
    setTenants(response.data.tenants);
  }
  useEffect(() => {
    try {
      return onAuthStateChanged(platformClient().auth, account => {
        setReady(false);
        setUser(null);
        if (!account) { window.location.replace('/till/'); return; }
        void account.getIdTokenResult().then(async token => {
          if (token.claims.platform_admin !== true) { window.location.replace('/till/'); return; }
          await loadTenants(); // Server also checks the active administrator registry.
          setUser(account);
        }).catch(async caught => {
          setError(caught.message || 'Could not verify platform access.');
        }).finally(() => setReady(true));
      });
    } catch (caught) { setError((caught as Error).message); setReady(true); }
  }, []);

  async function chooseLogo(file?: File) {
    setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 130 * 1024) {
      setError('Choose a PNG, JPEG or WebP logo smaller than 130 KB.'); return;
    }
    const reader = new FileReader();
    reader.onload = () => setForm(value => ({ ...value, logoUrl: String(reader.result) }));
    reader.onerror = () => setError('Could not read this logo. Choose the file again.');
    reader.readAsDataURL(file);
  }
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setNotice(''); setCreated(null);
    const payload = JSON.stringify(form);
    request.current ??= { id: crypto.randomUUID(), payload };
    if (request.current.payload !== payload) request.current = { id: crypto.randomUUID(), payload };
    try {
      const result = await httpsCallable<unknown, Tenant>(platformClient().functions, 'createPlatformTenant')({ ...form, requestId: request.current.id });
      setCreated(result.data); setForm(empty); request.current = null;
      setNotice(`${result.data.businessName} is ready. Give the owner their email and the password you entered using your usual secure channel.`);
      try { await loadTenants(); } catch { setNotice('Business created. Refresh the page to reload the business list.'); }
    } catch (caught) { setError((caught as Error).message || 'Could not create this business. Retry with the same details.'); }
    finally { setBusy(false); }
  }
  const field = (key: keyof typeof empty, value: string) => setForm(current => ({ ...current, [key]: value }));

  return <div className="platform-shell">
    <aside className="platform-sidebar">
      <Link href="/platform/" className="platform-brand">Vanbransa<span>ProPos</span></Link>
      <nav aria-label="Platform navigation"><a href="#businesses" aria-current="page">Businesses</a>{user && <a href="#new-business">Add a business</a>}</nav>
      <div className="platform-sidebar-footer">{user && <span>{user.email}</span>}<button type="button" disabled={busy} onClick={() => void signOut(platformClient().auth)}>Sign out</button></div>
    </aside>
    <main className="platform-main">
      <header><h1>Business onboarding</h1><p>Create a separate workspace for each business, with its own owner, branch and branding.</p></header>
      {error && <p className="platform-error" role="alert">{error}</p>}
      {notice && <p className="platform-notice" role="status">{notice}</p>}
      {!ready ? <p role="status">Checking your access…</p> : !user ? <p>Access could not be verified. Sign out and use the central sign-in page to try again.</p> : <>
        <section id="new-business" className="platform-create"><h2>Add a business</h2><p>The owner signs into this same POS using the account created here.</p>
          <form onSubmit={create}>
            <fieldset disabled={busy}><legend>Business details</legend><div className="platform-grid">
              <label>Business name<input required maxLength={120} value={form.businessName} onChange={event => field('businessName', event.target.value)} /></label>
              <label>Business identifier<input required pattern="[a-z][a-z0-9\-]{1,46}[a-z0-9]" minLength={3} maxLength={48} placeholder="e.g. lakeside-cafe" value={form.slug} onChange={event => field('slug', event.target.value.toLowerCase())} /><small>3–48 lowercase letters, numbers or single hyphens. Start with a letter and end with a letter or number.</small></label>
              <label>First branch name<input required maxLength={120} value={form.branchName} onChange={event => field('branchName', event.target.value)} /></label>
              <label>Business logo <span className="platform-optional">(optional)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseLogo(event.target.files?.[0])} /><small>PNG, JPEG or WebP, up to 130 KB. Appears above the left menu.</small></label>
            </div>{form.logoUrl && <div className="platform-logo-preview"><img src={form.logoUrl} alt="Business logo preview" /><button type="button" onClick={() => field('logoUrl', '')}>Remove logo</button></div>}</fieldset>
            <fieldset disabled={busy}><legend>Owner account</legend><div className="platform-grid">
              <label>Owner name<input required maxLength={120} autoComplete="off" value={form.ownerName} onChange={event => field('ownerName', event.target.value)} /></label>
              <label>Owner email<input required type="email" maxLength={254} autoComplete="off" value={form.ownerEmail} onChange={event => field('ownerEmail', event.target.value)} /></label>
              <label>Initial password<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={form.ownerPassword} onChange={event => field('ownerPassword', event.target.value)} /><small>Use at least 12 characters. Share it securely with the owner.</small></label>
            </div></fieldset>
            <div className="platform-form-footer"><p>Starts with an empty catalogue and cash payments. The owner can add products and staff after signing in.</p><button className="platform-primary" disabled={busy}>{busy ? 'Creating business…' : 'Create business and owner'}</button></div>
          </form>
        </section>
        {created && <section className="platform-result" aria-label="Created business"><h2>{created.businessName} is ready</h2><p>Owner: {created.ownerEmail}</p><p>Business ID: {created.tenantId}</p><Link href="/till/" target="_blank">Open POS sign in</Link></section>}
        <section id="businesses" className="platform-businesses"><h2>Businesses</h2>{!tenants.length ? <p>No businesses have been onboarded yet.</p> : <div className="platform-table-wrap"><table><thead><tr><th>Business</th><th>Owner</th><th>Status</th></tr></thead><tbody>{tenants.map(tenant => <tr key={tenant.tenantId}><td><div className="platform-business-name">{tenant.logoUrl && <img src={tenant.logoUrl} alt="" />}<span>{tenant.businessName}<small>{tenant.slug || tenant.tenantId}</small></span></div></td><td>{tenant.ownerEmail || '—'}</td><td>{tenant.status}</td></tr>)}</tbody></table></div>}</section>
      </>}
    </main>
  </div>;
}
