fn main() {
    // Embed Windows application manifest (requireAdministrator for UAC)
    #[cfg(windows)]
    {
        let _ = embed_resource::compile("assets/installer.rc", embed_resource::NONE);
    }
}
