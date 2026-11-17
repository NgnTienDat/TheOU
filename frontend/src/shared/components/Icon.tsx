const paths = {
  home: 'm3 10 9-7 9 7v10h-6v-7H9v7H3V10Z',
  plus: 'M12 5v14M5 12h14',
  pen: 'M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7m-6-1 7-7a2 2 0 0 1 3 3l-7 7-4 1 1-4Z',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21a8 8 0 0 1 16 0',
  anon: 'M7.5 7.8C9 6.8 10.2 6.5 12 6.5s3 .3 4.5 1.3M5.4 11.7l1 1.3a7 7 0 0 0 11.2 0l1-1.3M7.5 17.8a6 6 0 0 0 9 0M9 11h.01M15 11h.01',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  moon: 'M20 15.5A8.7 8.7 0 0 1 8.5 4 8.7 8.7 0 1 0 20 15.5Z',
  heart: 'M20.8 5.6a5.6 5.6 0 0 0-7.9 0l-.9.9-.9-.9a5.6 5.6 0 0 0-7.9 7.9c4 4 8.8 8.2 8.8 8.2s4.8-4.2 8.8-8.2a5.6 5.6 0 0 0 0-7.9Z',
  message: 'M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.7-.9L3 21l1.9-4.8A8.5 8.5 0 1 1 20 11.5Z',
  share: 'm22 2-7 20-4-9-9-4Zm0 0L11 13',
  back: 'M19 12H5m7 7-7-7 7-7',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17',
  send: 'M12 19V5m-7 7 7-7 7 7',
  trash: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
  more: 'm6 9 6 6 6-6',
}

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
