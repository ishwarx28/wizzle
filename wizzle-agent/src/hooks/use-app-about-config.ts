import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

import { getRemoteConfig } from "../lib/remote-config";

export function useAppAboutConfig() {
  const remoteConfig = getRemoteConfig();
  const [version, setVersion] = useState("");

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((packagedVersion) => {
        if (active) {
          setVersion(packagedVersion.trim());
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return {
    ...remoteConfig.developer,
    update: remoteConfig.update,
    version,
  };
}
