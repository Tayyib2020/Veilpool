export type FheSdkInitializer = () => Promise<unknown> | unknown;

export type FheInstanceCreator<TConfig, TInstance> = (config: TConfig) => Promise<TInstance> | TInstance;

export function createFheSdkInitializer(initializeSdk: FheSdkInitializer) {
  let initializationPromise: Promise<void> | undefined;

  return async function ensureInitialized(): Promise<void> {
    if (!initializationPromise) {
      const pending = Promise.resolve(initializeSdk()).then(() => undefined);
      initializationPromise = pending;
      void pending.catch(() => {
        if (initializationPromise === pending) initializationPromise = undefined;
      });
    }
    return initializationPromise;
  };
}

export function createInitializedFheInstance<TConfig, TInstance>(
  initializeSdk: FheSdkInitializer,
  createInstance: FheInstanceCreator<TConfig, TInstance>,
) {
  const ensureInitialized = createFheSdkInitializer(initializeSdk);
  return async (config: TConfig): Promise<TInstance> => {
    await ensureInitialized();
    return createInstance(config);
  };
}
