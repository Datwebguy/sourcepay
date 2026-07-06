import { useEffect, useState } from 'react';
import type {
  AppView,
  ConnectedWallet,
  WalletConnector,
  WalletConnectionState,
  Receipt,
} from './types';
import {
  clearWalletProviderEvents,
  connectWalletProvider,
  bindWalletProviderEvents,
  getEthereumProvider,
  getInjectedProvider,
  setActiveWalletProvider,
  setWalletConnectProvider,
} from './utils';
import { AppErrorBoundary } from './components/Common';
import { LandingPage } from './components/LandingPage';
import { PlatformPage } from './components/PlatformPage';
import { CreatorPage } from './components/CreatorPage';
import { SourcePage } from './components/SourcePage';
import { ReceiptPage } from './components/ReceiptPage';

export function useSmallViewport() {
  const [isSmallViewport, setIsSmallViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  );

  useEffect(() => {
    const update = () => setIsSmallViewport(window.innerWidth < 640);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return isSmallViewport;
}

function App() {
  const initialReceiptId =
    typeof window !== 'undefined'
      ? window.location.pathname.match(/^\/receipt\/([^/]+)$/)?.[1]
      : undefined;
  const initialAccessToken =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('access')
      : null;
  const initialSourceId =
    typeof window !== 'undefined'
      ? window.location.pathname.match(/^\/source\/([^/]+)$/)?.[1]
      : undefined;
  const initialView =
    initialReceiptId
      ? 'receipt'
      : initialSourceId
        ? 'source'
        : typeof window !== 'undefined' && window.location.pathname === '/creator'
          ? 'creator'
          : 'landing';
  const [view, setView] = useState<AppView>(initialView);
  const [receiptId, setReceiptId] = useState(initialReceiptId ?? '');
  const [activeReceipt, setActiveReceipt] = useState<Receipt | null>(null);
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [sourceRefreshCounter, setSourceRefreshCounter] = useState(0);
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet>({
    address: null,
    connector: null,
  });
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [walletConnection, setWalletConnection] = useState<WalletConnectionState>({
    connector: null,
    message: '',
    error: '',
  });

  useEffect(() => {
    setConnectedWallet({ address: null, connector: null });
  }, []);

  const resetConnectedWallet = () => {
    setActiveWalletProvider(null);
    setWalletConnectProvider(null);
    clearWalletProviderEvents();
    setConnectedWallet({ address: null, connector: null });
  };

  const connectWallet = async (connector?: WalletConnector) => {
    setIsConnectingWallet(true);
    const selectedConnector = connector ?? (getInjectedProvider() ? 'injected' : 'walletconnect');
    setWalletConnection({
      connector: selectedConnector,
      message:
        selectedConnector === 'walletconnect'
          ? 'Opening WalletConnect'
          : 'Opening wallet',
      error: '',
    });

    try {
      const wallet = await connectWalletProvider(selectedConnector);
      setConnectedWallet(wallet);
      const provider = getEthereumProvider();
      if (provider) {
        bindWalletProviderEvents({
          provider,
          connector: wallet.connector ?? selectedConnector,
          onAccountsChanged: setConnectedWallet,
          onDisconnected: resetConnectedWallet,
        });
      }
      setWalletConnection({ connector: null, message: '', error: '' });
      return wallet.address;
    } catch (error) {
      const message = (error as Error).message || 'Wallet connection failed.';
      setWalletConnection({
        connector: selectedConnector,
        message: '',
        error:
          selectedConnector === 'walletconnect'
            ? `WalletConnect failed: ${message}`
            : message,
      });
      throw error;
    } finally {
      setIsConnectingWallet(false);
    }
  };

  const disconnectWallet = async () => {
    const provider = getEthereumProvider();
    if (connectedWallet.connector === 'walletconnect' && (provider as any)?.disconnect) {
      await (provider as any).disconnect().catch(() => undefined);
    }
    resetConnectedWallet();
    setWalletConnection({ connector: null, message: '', error: '' });
  };

  const navigate = (nextView: AppView, nextId = '', nextReceipt: Receipt | null = null) => {
    const previousView = view;
    setView(nextView);
    setReceiptId(nextView === 'receipt' ? nextId : '');
    setActiveReceipt(nextView === 'receipt' ? nextReceipt : null);
    setSourceId(nextView === 'source' ? nextId : '');
    if (previousView === 'creator' && nextView === 'platform') {
      setSourceRefreshCounter((current) => current + 1);
    }

    if (nextView === 'receipt' && nextId) {
      const accessQuery =
        nextReceipt?.accessToken &&
        !(nextReceipt.paymentStatus === 'paid' || nextReceipt.paymentStatus === 'settled')
          ? `?access=${encodeURIComponent(nextReceipt.accessToken)}`
          : '';
      window.history.pushState(null, '', `/receipt/${nextId}${accessQuery}`);
      return;
    }

    if (nextView === 'source' && nextId) {
      window.history.pushState(null, '', `/source/${nextId}`);
      return;
    }

    window.history.pushState(
      null,
      '',
      nextView === 'creator' ? '/creator' : '/',
    );
  };

  return (
    <AppErrorBoundary>
      <main className="relative w-full overflow-x-hidden">
        {view === 'landing' ? (
          <LandingPage onLaunch={() => navigate('platform')} />
        ) : view === 'platform' ? (
          <PlatformPage
            onBack={() => navigate('landing')}
            onOpenCreator={() => navigate('creator')}
            onOpenReceipt={(id, nextReceipt) => navigate('receipt', id, nextReceipt ?? null)}
            onOpenSource={(id) => navigate('source', id)}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            onDisconnectWallet={disconnectWallet}
            isConnectingWallet={isConnectingWallet}
            walletConnection={walletConnection}
            sourceRefreshKey={sourceRefreshCounter}
          />
        ) : view === 'creator' ? (
          <CreatorPage
            onBack={() => navigate('platform')}
            onOpenSource={(id) => navigate('source', id)}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            onDisconnectWallet={disconnectWallet}
            isConnectingWallet={isConnectingWallet}
            walletConnection={walletConnection}
          />
        ) : view === 'source' ? (
          <SourcePage
            id={sourceId}
            onBack={() => navigate('platform')}
            onOpenReceipt={(id, nextReceipt) => navigate('receipt', id, nextReceipt ?? null)}
          />
        ) : (
          <ReceiptPage
            id={receiptId}
            initialReceipt={activeReceipt}
            initialAccessToken={initialAccessToken}
            onBack={() => navigate('platform')}
            connectedWallet={connectedWallet}
            onConnectWallet={connectWallet}
            isConnectingWallet={isConnectingWallet}
          />
        )}
      </main>
    </AppErrorBoundary>
  );
}

export default App;
export { App };
