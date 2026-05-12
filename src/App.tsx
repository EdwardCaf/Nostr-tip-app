import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { SimplePool, finalizeEvent, nip19, nip57, type EventTemplate } from 'nostr-tools'
import './App.css'

const pool = new SimplePool()

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const PRESET_AMOUNTS = [500, 1000, 5000, 10000]
const DEFAULT_NOTE = 'Thanks for what you create on Nostr.'

type Profile = {
  name?: string
  display_name?: string
  about?: string
  picture?: string
  banner?: string
  website?: string
  nip05?: string
  lud06?: string
  lud16?: string
}

type ProfileState = {
  pubkey: string
  npub: string
  profile: Profile
}

type LnurlPayDetails = {
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  commentAllowed?: number
  domain: string
}

type InvoiceState = {
  pr: string
  verify?: string
  successAction?: unknown
}

type Nip05Status = 'idle' | 'checking' | 'verified' | 'invalid'
type PaymentStatus = 'idle' | 'awaiting' | 'paid' | 'unsupported'

const PAYMENT_POLL_INTERVAL_MS = 3000
const PAYMENT_POLL_TIMEOUT_MS = 120000

function parseProfile(rawContent: string) {
  try {
    return JSON.parse(rawContent) as Profile
  } catch {
    return null
  }
}

function normalizeWebsite(url?: string | null) {
  if (!url) {
    return null
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }

  return `https://${url}`
}

function formatIdentity(profile: Profile | null, npub: string) {
  if (!profile) {
    return npub.slice(0, 14)
  }

  return profile.display_name || profile.name || npub.slice(0, 14)
}

function formatHandle(profile: Profile | null, npub: string) {
  if (profile?.name) {
    return `@${profile.name}`
  }

  return `${npub.slice(0, 12)}...${npub.slice(-6)}`
}

function decodeNpub(npub: string) {
  const decoded = nip19.decode(npub.trim())

  if (decoded.type !== 'npub') {
    throw new Error('That value is not a valid npub.')
  }

  return decoded.data
}

function isValidNpub(value: string) {
  try {
    decodeNpub(value)
    return true
  } catch {
    return false
  }
}

function decodeLud06(lud06: string) {
  const normalized = lud06.trim()

  if (!normalized.toLowerCase().startsWith('lnurl')) {
    throw new Error('Lightning data is present but not a valid lud06 LNURL.')
  }

  return normalized
}

function buildLnurlUrl(profile: Profile) {
  if (profile.lud16) {
    const [name, domain] = profile.lud16.split('@')

    if (!name || !domain) {
      throw new Error('Lightning address is malformed.')
    }

    return `https://${domain}/.well-known/lnurlp/${name}`
  }

  if (profile.lud06) {
    return decodeLud06(profile.lud06)
  }

  throw new Error('This profile does not publish a Lightning address.')
}

function parseLnurlPayUrl(rawUrl: string) {
  const parsed = new URL(rawUrl)
  return { href: parsed.toString(), domain: parsed.hostname }
}

function getPathNpub(pathname: string) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed || null
}

function buildProfilePath(npub: string) {
  return `/${npub.trim()}`
}

async function fetchProfile(npub: string): Promise<ProfileState> {
  const pubkey = decodeNpub(npub)
  const event = await pool.get(RELAYS, { kinds: [0], authors: [pubkey] })

  if (!event) {
    throw new Error('No profile metadata was found on the selected relays.')
  }

  const profile = parseProfile(event.content)

  if (!profile) {
    throw new Error('The profile metadata could not be parsed.')
  }

  return { pubkey, npub, profile }
}

async function verifyNip05(nip05: string, pubkey: string) {
  const trimmed = nip05.trim()

  if (!trimmed || !trimmed.includes('@')) {
    return false
  }

  const [name, domain] = trimmed.split('@')

  if (!name || !domain) {
    return false
  }

  const url = new URL(`https://${domain}/.well-known/nostr.json`)
  url.searchParams.set('name', name)

  const response = await fetch(url.toString())

  if (!response.ok) {
    return false
  }

  const data = (await response.json()) as {
    names?: Record<string, string>
  }

  return data.names?.[name]?.toLowerCase() === pubkey.toLowerCase()
}

async function fetchLnurlPay(profile: Profile) {
  const { href, domain } = parseLnurlPayUrl(buildLnurlUrl(profile))
  const response = await fetch(href)

  if (!response.ok) {
    throw new Error('Unable to fetch Lightning pay details.')
  }

  const data = (await response.json()) as Partial<LnurlPayDetails> & {
    status?: string
    reason?: string
    tag?: string
  }

  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'Lightning server returned an error.')
  }

  if (data.tag !== 'payRequest' || !data.callback || !data.minSendable || !data.maxSendable || !data.metadata) {
    throw new Error('Lightning pay details are incomplete.')
  }

  return {
    callback: data.callback,
    minSendable: data.minSendable,
    maxSendable: data.maxSendable,
    metadata: data.metadata,
    commentAllowed: data.commentAllowed,
    domain,
  } satisfies LnurlPayDetails
}

async function generateZapRequest(pubkey: string, amountMsats: number, note: string) {
  const privateKey = crypto.getRandomValues(new Uint8Array(32))
  const eventTemplate: EventTemplate = {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    content: note,
    tags: [
      ['p', pubkey],
      ['amount', String(amountMsats)],
      ['relays', ...RELAYS],
    ],
  }

  return JSON.stringify(finalizeEvent(eventTemplate, privateKey))
}

async function fetchInvoice(
  details: LnurlPayDetails,
  amountSats: number,
  note: string,
  pubkey: string,
) {
  const amountMsats = amountSats * 1000

  if (amountMsats < details.minSendable || amountMsats > details.maxSendable) {
    throw new Error(
      `Enter an amount between ${Math.ceil(details.minSendable / 1000)} and ${Math.floor(details.maxSendable / 1000)} sats.`,
    )
  }

  const url = new URL(details.callback)
  url.searchParams.set('amount', String(amountMsats))

  if (note.trim() && details.commentAllowed && note.length <= details.commentAllowed) {
    url.searchParams.set('comment', note.trim())
  }

  try {
    const unsignedZapRequest = nip57.makeZapRequest({
      pubkey,
      amount: amountMsats,
      comment: note.trim(),
      relays: RELAYS,
    })
    const privateKey = crypto.getRandomValues(new Uint8Array(32))
    const encodedZapRequest = JSON.stringify(finalizeEvent(unsignedZapRequest, privateKey))

    url.searchParams.set('nostr', encodedZapRequest)
  } catch {
    const zapRequest = await generateZapRequest(pubkey, amountMsats, note.trim())
    url.searchParams.set('nostr', zapRequest)
  }

  const response = await fetch(url.toString())

  if (!response.ok) {
    throw new Error('Unable to create a Lightning invoice.')
  }

  const data = (await response.json()) as InvoiceState & {
    status?: string
    reason?: string
  }

  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'Lightning server returned an invoice error.')
  }

  if (!data.pr) {
    throw new Error('Lightning server did not return a payment request.')
  }

  return data
}

async function checkInvoicePaid(verifyUrl: string) {
  const response = await fetch(verifyUrl)

  if (!response.ok) {
    throw new Error('Unable to verify invoice payment status.')
  }

  const data = (await response.json()) as {
    status?: string
    settled?: boolean
    paid?: boolean
    preimage?: string
    pr?: string
    result?: string
  }

  if (data.status === 'ERROR') {
    return false
  }

  if (data.settled === true || data.paid === true || typeof data.preimage === 'string') {
    return true
  }

  return data.result === 'paid'
}

function App() {
  const [inputValue, setInputValue] = useState('')
  const [activeNpub, setActiveNpub] = useState<string | null>(null)
  const [routeError, setRouteError] = useState('')
  const [profileState, setProfileState] = useState<ProfileState | null>(null)
  const [lnurlPay, setLnurlPay] = useState<LnurlPayDetails | null>(null)
  const [invoice, setInvoice] = useState<InvoiceState | null>(null)
  const [selectedAmount, setSelectedAmount] = useState(1000)
  const [note, setNote] = useState(DEFAULT_NOTE)
  const [profileError, setProfileError] = useState('')
  const [invoiceError, setInvoiceError] = useState('')
  const [isLoadingProfile, setIsLoadingProfile] = useState(false)
  const [isLoadingInvoice, setIsLoadingInvoice] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedNpub, setCopiedNpub] = useState(false)
  const [nip05Status, setNip05Status] = useState<Nip05Status>('idle')
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('idle')

  useEffect(() => {
    const pathNpub = getPathNpub(window.location.pathname)
    const queryNpub = new URLSearchParams(window.location.search).get('npub')?.trim() || null

    if (pathNpub) {
      if (isValidNpub(pathNpub)) {
        setActiveNpub(pathNpub)
        setInputValue(pathNpub)
        setRouteError('')
      } else {
        setActiveNpub(null)
        setInputValue('')
        setRouteError('That URL does not contain a valid npub.')
      }

      return
    }

    if (queryNpub && isValidNpub(queryNpub)) {
      const nextPath = buildProfilePath(queryNpub)
      window.history.replaceState({}, '', nextPath)
      setActiveNpub(queryNpub)
      setInputValue(queryNpub)
      setRouteError('')
      return
    }

    setActiveNpub(null)
    setInputValue('')
    setRouteError('')
  }, [])

  useEffect(() => {
    if (!activeNpub) {
      setProfileState(null)
      setLnurlPay(null)
      setInvoice(null)
      setProfileError('')
      setNip05Status('idle')
      setPaymentStatus('idle')
      return
    }

    const npub = activeNpub

    let cancelled = false

    async function load() {
      setIsLoadingProfile(true)
      setProfileError('')
      setInvoiceError('')
      setInvoice(null)
      setLnurlPay(null)
      setNip05Status('idle')
      setPaymentStatus('idle')
      setCopiedNpub(false)

      try {
        const loadedProfile = await fetchProfile(npub)
        const lnurlDetails = await fetchLnurlPay(loadedProfile.profile)

        if (cancelled) {
          return
        }

        setProfileState(loadedProfile)
        setLnurlPay(lnurlDetails)
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Unable to load this profile.'
        setProfileState(null)
        setProfileError(message)
      } finally {
        if (!cancelled) {
          setIsLoadingProfile(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [activeNpub])

  useEffect(() => {
    const currentNip05 = profileState?.profile.nip05
    const currentPubkey = profileState?.pubkey

    if (!currentNip05 || !currentPubkey) {
      setNip05Status('idle')
      return
    }

    const nip05 = currentNip05
    const pubkey = currentPubkey
    let cancelled = false

    async function runVerification() {
      setNip05Status('checking')

      try {
        const isVerified = await verifyNip05(nip05, pubkey)

        if (!cancelled) {
          setNip05Status(isVerified ? 'verified' : 'invalid')
        }
      } catch {
        if (!cancelled) {
          setNip05Status('invalid')
        }
      }
    }

    void runVerification()

    return () => {
      cancelled = true
    }
  }, [profileState])

  useEffect(() => {
    const currentVerifyUrl = invoice?.verify

    if (!invoice?.pr) {
      setPaymentStatus('idle')
      return
    }

    if (!currentVerifyUrl) {
      setPaymentStatus('unsupported')
      return
    }

    const verifyUrl = currentVerifyUrl

    let cancelled = false
    let timeoutId: number | undefined
    let intervalId: number | undefined

    async function pollPayment() {
      try {
        const isPaid = await checkInvoicePaid(verifyUrl)

        if (cancelled) {
          return
        }

        if (isPaid) {
          setPaymentStatus('paid')

          if (intervalId) {
            window.clearInterval(intervalId)
          }

          if (timeoutId) {
            window.clearTimeout(timeoutId)
          }
        }
      } catch {
        if (!cancelled) {
          setPaymentStatus('unsupported')

          if (intervalId) {
            window.clearInterval(intervalId)
          }

          if (timeoutId) {
            window.clearTimeout(timeoutId)
          }
        }
      }
    }

    setPaymentStatus('awaiting')
    void pollPayment()

    intervalId = window.setInterval(() => {
      void pollPayment()
    }, PAYMENT_POLL_INTERVAL_MS)

    timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        setPaymentStatus('unsupported')
      }

      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }, PAYMENT_POLL_TIMEOUT_MS)

    return () => {
      cancelled = true

      if (intervalId) {
        window.clearInterval(intervalId)
      }

      if (timeoutId) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [invoice])

  const amountRange = useMemo(() => {
    if (!lnurlPay) {
      return null
    }

    return {
      min: Math.ceil(lnurlPay.minSendable / 1000),
      max: Math.floor(lnurlPay.maxSendable / 1000),
    }
  }, [lnurlPay])

  const website = normalizeWebsite(profileState?.profile?.website)
  const title = formatIdentity(profileState?.profile ?? null, activeNpub ?? '')
  const handle = formatHandle(profileState?.profile ?? null, activeNpub ?? '')
  const nip05Label =
    nip05Status === 'verified'
      ? 'Verified'
      : nip05Status === 'invalid'
        ? 'Unverified'
        : 'Checking'

  function navigateToNpub(npub: string) {
    const nextNpub = npub.trim()

    if (!nextNpub) {
      return
    }

    window.history.pushState({}, '', buildProfilePath(nextNpub))
    setRouteError(isValidNpub(nextNpub) ? '' : 'That URL does not contain a valid npub.')
    setActiveNpub(nextNpub)
    setInputValue(nextNpub)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCopied(false)
    setCopiedNpub(false)
    navigateToNpub(inputValue)
  }

  async function handleGenerateInvoice() {
    if (!profileState || !lnurlPay) {
      return
    }

    setIsLoadingInvoice(true)
    setInvoiceError('')
    setCopied(false)
    setPaymentStatus('idle')

    try {
      const nextInvoice = await fetchInvoice(lnurlPay, selectedAmount, note, profileState.pubkey)
      setInvoice(nextInvoice)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to generate an invoice.'
      setInvoice(null)
      setInvoiceError(message)
    } finally {
      setIsLoadingInvoice(false)
    }
  }

  async function handleCopyInvoice() {
    if (!invoice?.pr) {
      return
    }

    await navigator.clipboard.writeText(invoice.pr)
    setCopied(true)
  }

  async function handleCopyNpub() {
    if (!activeNpub) {
      return
    }

    await navigator.clipboard.writeText(activeNpub)
    setCopiedNpub(true)
  }

  if (!activeNpub) {
    return (
      <main className="page-shell">
        <section className="landing-card">
          <span className="landing-kicker">Nostr tipping</span>
          <h1>Create a donation page from any npub.</h1>
          <p>
            Paste a Nostr public key to generate a shareable Lightning tipping page.
          </p>

          <form className="npub-form landing-form" onSubmit={handleSubmit}>
            <div className="npub-row">
              <input
                id="npub-input"
                name="npub"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                placeholder="Enter npub"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" disabled={!inputValue.trim()}>
                Open page
              </button>
            </div>
          </form>

          {routeError && <p className="error-box">{routeError}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="content-stack">
        <article className="profile-card">
          <div
            className="banner"
            style={{
              backgroundImage: profileState?.profile?.banner
                ? `linear-gradient(180deg, rgba(10, 12, 20, 0.05), rgba(10, 12, 20, 0.82)), url(${profileState.profile.banner})`
                : undefined,
            }}
          >
            {!profileState?.profile?.banner && <div className="banner-fallback" />}
          </div>

          <div className="profile-body">
            <div className="identity-row">
              <div className="avatar-wrap">
                {profileState?.profile?.picture ? (
                  <img className="avatar" src={profileState.profile.picture} alt={title} />
                ) : (
                  <div className="avatar avatar-fallback">{title.slice(0, 1).toUpperCase()}</div>
                )}
              </div>

              <div className="identity-copy">
                <h2>{title}</h2>
                <p className="handle">{handle}</p>
              </div>
            </div>

            <p className="bio">
              {profileState?.profile?.about ||
                'A Nostr creator ready to receive direct Lightning support.'}
            </p>

            <div className="meta-row">
              {profileState?.profile?.nip05 && (
                <span
                  className={
                    nip05Status === 'verified'
                      ? 'meta-badge nip05-badge verified'
                      : nip05Status === 'invalid'
                        ? 'meta-badge nip05-badge invalid'
                        : 'meta-badge nip05-badge checking'
                  }
                >
                  <span className="nip05-icon" aria-hidden="true">
                    {nip05Status === 'verified' ? '✓' : nip05Status === 'invalid' ? '✕' : '•'}
                  </span>
                  <span>{profileState.profile.nip05}</span>
                  <span className="nip05-label">{nip05Label}</span>
                </span>
              )}
              {website && (
                <a href={website} target="_blank" rel="noreferrer" className="meta-badge meta-link">
                  Visit website
                </a>
              )}
              <a
                href={`https://primal.net/p/${activeNpub}`}
                target="_blank"
                rel="noreferrer"
                className="meta-badge meta-link"
              >
                Visit profile
              </a>
              <button type="button" className="meta-badge meta-button" onClick={() => void handleCopyNpub()}>
                <span>{activeNpub.slice(0, 18)}...{activeNpub.slice(-8)}</span>
                <span className="meta-button-label">{copiedNpub ? 'Copied' : 'Copy npub'}</span>
              </button>
            </div>

            {profileError && <p className="error-box">{profileError}</p>}
          </div>
        </article>

        <aside className="tip-card">
          <div className="tip-header">
            <h3>Send sats</h3>
            <p>
              {amountRange
                ? `Accepted range: ${amountRange.min} to ${amountRange.max} sats.`
                : 'Lightning details will appear once the profile loads.'}
            </p>
          </div>

          <div className="amount-grid">
            {PRESET_AMOUNTS.map((amount) => (
              <button
                key={amount}
                type="button"
                className={amount === selectedAmount ? 'amount-chip active' : 'amount-chip'}
                onClick={() => setSelectedAmount(amount)}
              >
                {amount.toLocaleString()} sats
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="custom-amount">
            Custom amount
          </label>
          <input
            id="custom-amount"
            className="field-input"
            type="number"
            min={amountRange?.min ?? 1}
            max={amountRange?.max ?? 1000000}
            value={selectedAmount}
            onChange={(event) => setSelectedAmount(Number(event.target.value))}
          />

          <label className="field-label" htmlFor="tip-note">
            Message
          </label>
          <textarea
            id="tip-note"
            className="field-input field-textarea"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a short note"
          />

          <button
            type="button"
            className="primary-button"
            disabled={isLoadingProfile || isLoadingInvoice || !profileState || !lnurlPay || selectedAmount <= 0}
            onClick={() => void handleGenerateInvoice()}
          >
            {isLoadingInvoice ? 'Generating invoice...' : 'Generate Lightning invoice'}
          </button>

          {invoiceError && <p className="error-box">{invoiceError}</p>}

          {paymentStatus === 'paid' && (
            <div className="payment-success-card">
              <span className="payment-success-kicker">Confirmed</span>
              <h4>Payment sent</h4>
              <p>The invoice has been paid and the donation was detected successfully.</p>
            </div>
          )}

          {invoice?.pr && paymentStatus !== 'paid' && (
            <div className="invoice-card">
              {paymentStatus !== 'unsupported' && (
                <div className="payment-status-row">
                  <span className="payment-status-dot" aria-hidden="true" />
                  <span>
                    {paymentStatus === 'awaiting'
                      ? 'Waiting for payment confirmation...'
                      : 'Preparing payment confirmation...'}
                  </span>
                </div>
              )}

              {paymentStatus === 'unsupported' && (
                <p className="payment-note">
                  Live confirmation is unavailable for this invoice. You can still pay with the QR code below.
                </p>
              )}

              <div className="qr-wrap">
                <QRCodeSVG value={invoice.pr} size={188} bgColor="transparent" fgColor="#f8fafc" />
              </div>

              <div className="invoice-copy">
                <p>Scan the QR code or copy the invoice string.</p>
                <code>{invoice.pr}</code>
              </div>

              <div className="invoice-actions">
                <button type="button" className="secondary-button" onClick={() => void handleCopyInvoice()}>
                  {copied ? 'Copied' : 'Copy invoice'}
                </button>
                {invoice.verify && (
                  <a href={invoice.verify} target="_blank" rel="noreferrer" className="secondary-link">
                    Verify payment
                  </a>
                )}
              </div>
            </div>
          )}
        </aside>

      </section>
    </main>
  )
}

export default App
