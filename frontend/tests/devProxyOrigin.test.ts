import { expect, test } from 'bun:test';
import { proxiedOrigin } from '../src/lib/devProxyOrigin';

const fronts = ['studio.ngrok-free.dev', 'mac.tailnet.ts.net'];
const backend = 'http://localhost:8000';
const write = (origin: string | undefined, host = 'localhost:5173', method = 'POST') =>
  proxiedOrigin(method, origin, host, fronts, backend);

test('a write from a page this dev server serves reaches the backend under the backend\'s own origin', () => {
  for (const origin of ['http://localhost:5173', 'http://localhost:5174', 'HTTP://LOCALHOST:5173',
    'http://127.0.0.1:5173', 'http://[::1]:5173', 'https://studio.ngrok-free.dev', 'https://mac.tailnet.ts.net:8446']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(write(origin, 'localhost:5173', method)).toBe(backend);
  }
  // A front that keeps the browser's Host (Vite has already checked it against server.allowedHosts).
  expect(write('http://192.168.1.20:5173', '192.168.1.20:5173')).toBe(backend);
  expect(write('https://mac.tailnet.ts.net:8446', 'mac.tailnet.ts.net:8446')).toBe(backend);
});

test('a write from any other page is refused', () => {
  for (const origin of ['https://evil.example', 'null', '', 'evil.example', 'file:///tmp/page.html',
    'https://evil.ngrok-free.dev', 'https://sub.studio.ngrok-free.dev', 'https://studio.ngrok-free.dev.evil.example',
    'http://localhost.evil.example', 'http://192.168.1.20:5173']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(write(origin, 'localhost:5173', method)).toBeNull();
  }
  expect(write('http://undefined', undefined as unknown as string)).toBeNull();
  expect(proxiedOrigin('POST', 'https://x.ts.net', 'localhost:5173', ['.ts.net', '*.ts.net'], backend)).toBeNull();
});

test('requests without an Origin and reads are forwarded untouched', () => {
  expect(write(undefined)).toBeUndefined();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    expect(write('https://evil.example', 'localhost:5173', method)).toBe('https://evil.example');
    expect(write('http://localhost:5173', 'localhost:5173', method)).toBe('http://localhost:5173');
  }
});
