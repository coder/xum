{
  description = "xum - coding agent multiplexer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Pinned to a tag: nix/package.nix relies on how fetchBunDeps calls bunNix.
    bun2nix = {
      url = "github:nix-community/bun2nix/2.1.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      bun2nix,
    }:
    {
      # The overlay builds xum with the consumer's nixpkgs (their glibc, Mesa and config).
      overlays.default = final: prev: {
        xum = final.callPackage ./nix/package.nix {
          # Take bun2nix from its overlay without adding it to the consumer's package set.
          inherit (bun2nix.overlays.default final prev) bun2nix;
          src = ./.;
          version = self.rev or self.dirtyRev or "dev";
          # Stamp buildTime from the flake's source date so the output is reproducible.
          sourceDateEpoch = self.lastModified or 315532800;
        };
      };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ self.overlays.default ];
        };
        inherit (pkgs) xum;
      in
      {
        packages.default = xum;
        packages.xum = xum;
        packages.mux = xum;

        formatter = pkgs.nixfmt;

        apps.default = {
          type = "app";
          program = "${xum}/bin/xum";
        };
        apps.xum = {
          type = "app";
          program = "${xum}/bin/xum";
        };
        apps.mux = {
          type = "app";
          program = "${xum}/bin/mux";
        };

        devShells.default = pkgs.mkShell {
          buildInputs =
            with pkgs;
            [
              bun

              # Node + build tooling
              nodejs
              gnumake
              stdenv.cc.cc.lib # Provides libstdc++.so.6 for DuckDB native bindings under Bun

              # Common CLIs
              git
              bash

              # Nix tooling
              nixfmt

              # Repo linting (make static-check)
              go
              hadolint
              shellcheck
              shfmt
              gh
              jq
              duckdb

              # Documentation
              mdbook
              mdbook-mermaid
              mdbook-linkcheck2
              mdbook-pagetoc

              # Browser automation
              agent-browser

              # Terminal bench + browser recording
              uv
              asciinema
              ffmpeg
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [
              docker
              # The Electron binary shipped in node_modules/electron/dist
              # is dynamically linked against standard FHS paths
              # (libglib-2.0.so.0, libnss3.so, etc.) that don't exist on
              # NixOS, so `make start` / `make dev` fail with "error while
              # loading shared libraries". Expose Nix's autoPatchelf'd
              # Electron and redirect the npm wrapper to it via
              # ELECTRON_OVERRIDE_DIST_PATH below.
              electron_44
            ];

          # Bun does not carry libstdc++ on Linux, so native modules like @duckdb/node-bindings
          # fail to dlopen during tests unless we expose the GCC runtime in the shell.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];

          # Point `node_modules/electron/cli.js` at the Nix-patched Electron
          # binary on Linux so `bunx electron` (used by `make start`/`make dev`)
          # finds its shared libraries on NixOS without needing an FHS wrapper.
          # Left unset on Darwin where the npm-shipped binary runs as-is.
          ELECTRON_OVERRIDE_DIST_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.electron_44}/libexec/electron";
        };
      }
    );
}
