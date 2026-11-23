{
  description = "fff's file search in the Herdr desktop app";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAll (pkgs: {
      # The binary in bin/, the mod in share/herdr-fff/mods/herdr-fff/.
      default = pkgs.rustPlatform.buildRustPackage {
        pname = "herdr-fff";
        version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package.version;
        src = self;
        cargoLock.lockFile = ./Cargo.lock;

        nativeBuildInputs = [pkgs.pkg-config];
        buildInputs = [pkgs.libgit2 pkgs.openssl pkgs.zlib];
        env.LIBGIT2_NO_VENDOR = "1";

        postInstall = ''
          mkdir -p $out/share/herdr-fff/mods
          cp -r mods/herdr-fff $out/share/herdr-fff/mods/
        '';

        meta = {
          description = "fff's file search in the Herdr desktop app";
          license = pkgs.lib.licenses.mit;
          mainProgram = "herdr-fff";
        };
      };
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {
        inputsFrom = [self.packages.${pkgs.stdenv.hostPlatform.system}.default];
        packages = [pkgs.cargo pkgs.rustc pkgs.clippy pkgs.rustfmt];
        LIBGIT2_NO_VENDOR = "1";
      };
    });

    formatter = forAll (pkgs: pkgs.alejandra);
  };
}
