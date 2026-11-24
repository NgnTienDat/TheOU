const shapes = {
  'home': <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z"/></>,
  'pen': <><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m13 11 7.5-7.5a2.12 2.12 0 0 1 3 3L16 14l-4 1 1-4Z" transform="translate(-1 -1)"/></>,
  'plus': <><path d="M12 5v14M5 12h14"/></>,
  'message': <><path d="M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.7-.9L3 21l1.9-4.8A8.5 8.5 0 1 1 20 11.5Z"/></>,
  'heart': <><path d="M20.8 5.6a5.6 5.6 0 0 0-7.9 0l-.9.9-.9-.9a5.6 5.6 0 0 0-7.9 7.9c4 4 8.8 8.2 8.8 8.2s4.8-4.2 8.8-8.2a5.6 5.6 0 0 0 0-7.9Z"/></>,
  'share': <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
  'send': <><path d="M12 19V5m-6 6 6-6 6 6"/></>,
  'back': <><path d="m14.5 5-7 7 7 7M8 12h13"/></>,
  'moon': <><path d="M20 15.5A8.7 8.7 0 0 1 8.5 4 8.7 8.7 0 1 0 20 15.5Z"/></>,
  'sun': <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></>,
  'more': <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  'copy': <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  'trash': <><path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/></>,
  'refresh': <><path d="M21 12a9 9 0 0 0-15.3-6.3L3 8m0-5v5h5M3 12a9 9 0 0 0 15.3 6.3L21 16m0 5v-5h-5"/></>,
  'user': <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  'anon': <><path d="M7.5 7.8C9 6.8 10.2 6.5 12 6.5s3 .3 4.5 1.3l1.1 1.1M5.4 11.7l1 1.3a7 7 0 0 0 11.2 0l1-1.3M7.5 17.8a6 6 0 0 0 9 0"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/></>,
  'link': <><path d="m10 13 4-4M8.5 15.5l-2 2a4 4 0 0 1-5.7-5.7l4.5-4.5A4 4 0 0 1 11 7M15.5 8.5l2-2a4 4 0 0 1 5.7 5.7l-4.5 4.5A4 4 0 0 1 13 17" transform="translate(1 0)"/></>,
  'chevron': <><path d="m6 9 6 6 6-6"/></>,
  'check': <><path d="m5 12 4 4L19 6"/></>,
  'shield': <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  'lock': <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></>,
  'alert': <><path d="M12 3 2 20h20L12 3Zm0 6v5m0 3v.1"/></>,
}

export function Icon({ name }: { name: keyof typeof shapes }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>
}
