import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './global.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } });
const basePath = new URL(document.baseURI).pathname.replace(/\/$/, '');
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter basename={basePath || '/'}><App /></BrowserRouter></QueryClientProvider></React.StrictMode>);
