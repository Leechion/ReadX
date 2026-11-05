type Packed = null | boolean | number | string | Packed[] | { [key: string]: Packed };
interface StoreDump {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  entries: { key: Packed; value: Packed }[];
}
interface BrowserDump { version: 1; local: Record<string, string>; databases: { name: string; version: number; stores: StoreDump[] }[] }

async function pack(value: unknown): Promise<Packed> {
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  };
  if (value instanceof Blob) return { $readxType: 'blob', mime: value.type, bytes: encode(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof ArrayBuffer) return { $readxType: 'buffer', bytes: encode(new Uint8Array(value)) };
  if (value instanceof Date) return { $readxType: 'date', value: value.toISOString() };
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await pack(item)])));
  if (value === undefined) return { $readxType: 'undefined' };
  return value as Packed;
}
function unpack(value: Packed): unknown {
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === 'object') {
    if (value.$readxType === 'blob') return new Blob([Uint8Array.from(atob(String(value.bytes)), c => c.charCodeAt(0))], { type: String(value.mime) });
    if (value.$readxType === 'buffer') return Uint8Array.from(atob(String(value.bytes)), c => c.charCodeAt(0)).buffer;
    if (value.$readxType === 'date') return new Date(String(value.value));
    if (value.$readxType === 'undefined') return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]));
  }
  return value;
}
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function complete(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('本地存储事务中止')); transaction.onerror = () => reject(transaction.error);
}); }

export async function captureBrowserBackup(): Promise<string> {
  const dump: BrowserDump = { version: 1, local: {}, databases: [] };
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const db = await request(indexedDB.open(info.name));
    try {
      const stores: StoreDump[] = [];
      const names = Array.from(db.objectStoreNames);
      const transaction = names.length ? db.transaction(names, 'readonly') : null;
      const done = transaction ? complete(transaction) : Promise.resolve();
      const snapshots = names.map(name => {
        const store = transaction!.objectStore(name);
        const keys = request(store.getAllKeys()), values = request(store.getAll());
        const indexes = Array.from(store.indexNames).map(name => { const index = store.index(name); return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; });
        return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys, values };
      });
      const contents = await Promise.all([Promise.all(snapshots.map(async snapshot => {
        const [allKeys, allValues] = await Promise.all([snapshot.keys, snapshot.values]);
        return { ...snapshot, allKeys, allValues };
      })), done]);
      for (const { name, keyPath, autoIncrement, indexes, allKeys, allValues } of contents[0]) {
        stores.push({ name, keyPath, autoIncrement, indexes,
          entries: await Promise.all(allValues.map(async (value, i) => ({ key: await pack(allKeys[i]), value: await pack(value) }))) });
      }
      dump.databases.push({ name: db.name, version: db.version, stores });
    } finally { db.close(); }
  }
  dump.local = { ...localStorage };
  return JSON.stringify(dump);
}

export async function restoreBrowserBackup(raw: string): Promise<void> {
  const dump = JSON.parse(raw) as BrowserDump;
  if (dump.version !== 1 || !dump.local || !Array.isArray(dump.databases)) throw new Error('桌面存储备份格式不受支持');
  for (const database of dump.databases) {
    const removal = indexedDB.deleteDatabase(database.name);
    await new Promise<void>((resolve, reject) => {
      removal.onsuccess = () => resolve();
      removal.onerror = () => reject(removal.error);
      removal.onblocked = () => reject(new Error('本地文库仍被其他窗口占用，请关闭其他阅读窗口后重启重试'));
    });
    const opening = indexedDB.open(database.name, database.version);
    opening.onupgradeneeded = () => {
      for (const source of database.stores) {
        const store = opening.result.createObjectStore(source.name, { keyPath: source.keyPath, autoIncrement: source.autoIncrement });
        for (const index of source.indexes) store.createIndex(index.name, index.keyPath, index);
      }
    };
    const db = await request(opening);
    try {
      if (database.stores.length) {
        const tx = db.transaction(database.stores.map(store => store.name), 'readwrite'), done = complete(tx);
        for (const source of database.stores) {
          const store = tx.objectStore(source.name);
          for (const entry of source.entries) {
            const value = unpack(entry.value);
            if (store.keyPath === null) store.put(value, unpack(entry.key) as IDBValidKey); else store.put(value);
          }
        }
        await done;
      }
    } finally { db.close(); }
  }
  localStorage.clear();
  for (const [key, value] of Object.entries(dump.local)) localStorage.setItem(key, value);
}
