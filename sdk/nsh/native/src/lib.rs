//! nsmetry's native part (`nsmetry/native`), deliberately empty.
//!
//! nsmetry is TSX: everything an app uses is `src/index.ts`, imported as
//! `"nsmetry"`. This crate is what carries it to crates.io, so that
//! `nsh add nsmetry` works like any other nshm, and NSH recognizes an nshm
//! crate by its `#[native_module]` at the root. It registers nothing: the
//! module exists only so the package is a well-formed nshm.

use nsh_core::prelude::*;

#[native_module("nsmetry/native")]
fn native(_registry: &mut Registry) {}
