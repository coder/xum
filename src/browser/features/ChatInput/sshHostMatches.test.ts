import { describe, expect, test } from "bun:test";
import { suggestSshHosts } from "./sshHostMatches";

const HOSTS = ["devbox", "gpu-01", "gpu-02", "build-dev", "staging", "prod"];

describe("suggestSshHosts", () => {
  test("an empty field offers the first hosts of the config", () => {
    expect(suggestSshHosts(HOSTS, "")).toEqual(["devbox", "gpu-01", "gpu-02", "build-dev"]);
  });

  test("hosts that start with the typed text come before those that only contain it", () => {
    expect(suggestSshHosts(HOSTS, "dev")).toEqual(["devbox", "build-dev"]);
  });

  test("a typed user is kept on every suggestion", () => {
    expect(suggestSshHosts(HOSTS, "ml@GPU")).toEqual(["ml@gpu-01", "ml@gpu-02"]);
  });

  test("the host already typed in full is not offered again", () => {
    expect(suggestSshHosts(HOSTS, "prod")).toEqual([]);
    expect(suggestSshHosts(HOSTS, "root@gpu-01")).toEqual([]);
  });
});
