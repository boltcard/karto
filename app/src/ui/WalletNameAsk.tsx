// The ask for the wallet's name over Home: a wallet set up before
// names, whose server now keeps one and has none, is asked once per start of the app (askedThisRun), prefilled with
// the phone's model. Closing it unsaved is allowed. It asks only while Home is in front (a wallet answer that lands
// with a page over Home, the Server page after Update server say, waits for Home), waits while the alerts offer is up
// (hold), and closes when a name saved on another phone arrives. Home holds the alerts offer while this is open (onOpen).
import * as Device from 'expo-device';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceName } from '../native/deviceName';
import { askedThisRun, nameAskDue, namePrefill } from '../wallet/walletName';
import { WalletNameSheet } from './WalletNameSheet';

/** wallet: the watch's last answer. save: names the wallet on its server. */
export function WalletNameAsk({ host, wallet, hold, onOpen, save }: {
  host: string; wallet: { name?: string } | null; hold: boolean; onOpen: (open: boolean) => void; save: (name: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const told = useRef(onOpen);
  told.current = onOpen;
  const name = wallet?.name;
  const [front, setFront] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFront(true);
      return () => setFront(false);
    }, []),
  );
  const due = front && !hold && nameAskDue(wallet, host, askedThisRun);
  useEffect(() => {
    if (!due || open) return;
    askedThisRun.add(host);
    setOpen(true);
    told.current(true);
  }, [due, open, host]);
  const close = () => {
    setOpen(false);
    told.current(false);
  };
  // Named on another phone meanwhile: nothing left to ask.
  useEffect(() => {
    if (open && name) close();
  }, [open, name]);
  if (!open) return null;
  return <WalletNameSheet start={namePrefill(deviceName(Device.modelName))} onSave={async (n) => void (await save(n))} onClose={close} />;
}
