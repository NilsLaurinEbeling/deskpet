// The console window would flash up next to the overlay on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deskpet_lib::run()
}
