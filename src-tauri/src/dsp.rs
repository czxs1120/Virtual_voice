//! Real-time processing for the mic → virtual cable transfer path:
//! input gain, noise gate, and peak limiter, plus level metering.
//!
//! Parameters live in atomics so the UI can adjust them while the audio
//! callback is running without taking locks on the audio thread.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DspSettings {
    pub gain_db: f32,
    pub gate_enabled: bool,
    pub gate_threshold_db: f32,
    pub limiter_enabled: bool,
    pub limiter_ceiling_db: f32,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            gate_enabled: false,
            gate_threshold_db: -50.0,
            limiter_enabled: true,
            limiter_ceiling_db: -1.0,
        }
    }
}

struct AtomicF32(AtomicU32);

impl AtomicF32 {
    const fn zero() -> Self {
        Self(AtomicU32::new(0))
    }
    fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
}

struct SharedParams {
    gain_db: AtomicF32,
    gate_enabled: AtomicBool,
    gate_threshold_db: AtomicF32,
    limiter_enabled: AtomicBool,
    limiter_ceiling_db: AtomicF32,
    input_peak: AtomicF32,
    output_peak: AtomicF32,
    gate_open: AtomicBool,
}

static PARAMS: SharedParams = SharedParams {
    gain_db: AtomicF32::zero(),
    gate_enabled: AtomicBool::new(false),
    gate_threshold_db: AtomicF32::zero(),
    limiter_enabled: AtomicBool::new(false),
    limiter_ceiling_db: AtomicF32::zero(),
    input_peak: AtomicF32::zero(),
    output_peak: AtomicF32::zero(),
    gate_open: AtomicBool::new(false),
};

pub fn apply_settings(s: &DspSettings) {
    PARAMS.gain_db.store(s.gain_db.clamp(-24.0, 24.0));
    PARAMS.gate_enabled.store(s.gate_enabled, Ordering::Relaxed);
    PARAMS.gate_threshold_db.store(s.gate_threshold_db.clamp(-90.0, 0.0));
    PARAMS.limiter_enabled.store(s.limiter_enabled, Ordering::Relaxed);
    PARAMS.limiter_ceiling_db.store(s.limiter_ceiling_db.clamp(-24.0, 0.0));
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Levels {
    /// Peak since last read, in dBFS (−100 when silent).
    pub input_db: f32,
    pub output_db: f32,
    pub gate_open: bool,
}

/// Returns and resets the peak meters.
pub fn take_levels() -> Levels {
    let to_db = |v: f32| if v > 1e-5 { 20.0 * v.log10() } else { -100.0 };
    let input = PARAMS.input_peak.load();
    let output = PARAMS.output_peak.load();
    PARAMS.input_peak.store(0.0);
    PARAMS.output_peak.store(0.0);
    Levels {
        input_db: to_db(input),
        output_db: to_db(output),
        gate_open: PARAMS.gate_open.load(Ordering::Relaxed),
    }
}

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Per-stream processing state (owned by the input callback).
pub struct Processor {
    sample_rate: f32,
    envelope: f32,
    gate_gain: f32,
    hold_left: u32,
    limiter_gain: f32,
}

impl Processor {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate.max(1) as f32,
            envelope: 0.0,
            gate_gain: 1.0,
            hold_left: 0,
            limiter_gain: 1.0,
        }
    }

    fn coef(&self, ms: f32) -> f32 {
        (-1.0 / (self.sample_rate * ms / 1000.0)).exp()
    }

    /// Process mono samples in place.
    pub fn process(&mut self, samples: &mut [f32]) {
        self.process_with(samples, &snapshot());
    }

    fn process_with(&mut self, samples: &mut [f32], p: &DspSettings) {
        let gain = db_to_lin(p.gain_db);
        let threshold = db_to_lin(p.gate_threshold_db);
        let ceiling = db_to_lin(p.limiter_ceiling_db);

        let env_attack = self.coef(1.0);
        let env_release = self.coef(60.0);
        let gate_open_coef = self.coef(2.0);
        let gate_close_coef = self.coef(80.0);
        let limiter_release = self.coef(120.0);
        let hold_samples = (self.sample_rate * 0.15) as u32;

        let mut in_peak = 0f32;
        let mut out_peak = 0f32;

        for s in samples.iter_mut() {
            let x = *s * gain;
            let ax = x.abs();
            in_peak = in_peak.max(ax);

            let mut y = x;

            if p.gate_enabled {
                let c = if ax > self.envelope { env_attack } else { env_release };
                self.envelope = c * self.envelope + (1.0 - c) * ax;
                let target = if self.envelope >= threshold {
                    self.hold_left = hold_samples;
                    1.0
                } else if self.hold_left > 0 {
                    self.hold_left -= 1;
                    1.0
                } else {
                    0.0
                };
                let c = if target > self.gate_gain { gate_open_coef } else { gate_close_coef };
                self.gate_gain = c * self.gate_gain + (1.0 - c) * target;
                y *= self.gate_gain;
            } else {
                self.gate_gain = 1.0;
            }

            if p.limiter_enabled {
                let peak = y.abs() * self.limiter_gain;
                if peak > ceiling {
                    self.limiter_gain = ceiling / y.abs().max(1e-9);
                } else {
                    self.limiter_gain =
                        limiter_release * self.limiter_gain + (1.0 - limiter_release) * 1.0;
                }
                y *= self.limiter_gain;
                y = y.clamp(-ceiling, ceiling);
            } else {
                y = y.clamp(-1.0, 1.0);
            }

            out_peak = out_peak.max(y.abs());
            *s = y;
        }

        if in_peak > PARAMS.input_peak.load() {
            PARAMS.input_peak.store(in_peak);
        }
        if out_peak > PARAMS.output_peak.load() {
            PARAMS.output_peak.store(out_peak);
        }
        PARAMS
            .gate_open
            .store(!p.gate_enabled || self.gate_gain > 0.5, Ordering::Relaxed);
    }
}

fn snapshot() -> DspSettings {
    DspSettings {
        gain_db: PARAMS.gain_db.load(),
        gate_enabled: PARAMS.gate_enabled.load(Ordering::Relaxed),
        gate_threshold_db: PARAMS.gate_threshold_db.load(),
        limiter_enabled: PARAMS.limiter_enabled.load(Ordering::Relaxed),
        limiter_ceiling_db: PARAMS.limiter_ceiling_db.load(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0).sin())
            .collect()
    }

    fn peak(v: &[f32]) -> f32 {
        v.iter().fold(0.0f32, |m, x| m.max(x.abs()))
    }

    #[test]
    fn limiter_keeps_output_under_ceiling() {
        let mut p = Processor::new(48_000);
        let settings = DspSettings {
            gain_db: 12.0,
            limiter_enabled: true,
            limiter_ceiling_db: -3.0,
            ..DspSettings::default()
        };
        let mut buf = sine(0.9, 48_000);
        p.process_with(&mut buf, &settings);
        assert!(peak(&buf) <= db_to_lin(-3.0) + 1e-4, "peak {}", peak(&buf));
    }

    #[test]
    fn gate_silences_noise_below_threshold() {
        let mut p = Processor::new(48_000);
        let settings = DspSettings {
            gate_enabled: true,
            gate_threshold_db: -40.0,
            limiter_enabled: false,
            ..DspSettings::default()
        };
        // -60 dBFS hiss for one second; after hold+release it should be ~silent.
        let mut buf = sine(0.001, 48_000);
        p.process_with(&mut buf, &settings);
        assert!(peak(&buf[40_000..]) < 1e-5, "tail peak {}", peak(&buf[40_000..]));
    }

    #[test]
    fn gate_passes_speech_level_signal() {
        let mut p = Processor::new(48_000);
        let settings = DspSettings {
            gate_enabled: true,
            gate_threshold_db: -40.0,
            limiter_enabled: false,
            ..DspSettings::default()
        };
        let mut buf = sine(0.3, 48_000);
        p.process_with(&mut buf, &settings);
        assert!(peak(&buf[24_000..]) > 0.29);
    }

    #[test]
    fn unity_settings_are_transparent_below_ceiling() {
        let mut p = Processor::new(48_000);
        let settings = DspSettings {
            limiter_enabled: false,
            ..DspSettings::default()
        };
        let src = sine(0.5, 4_800);
        let mut buf = src.clone();
        p.process_with(&mut buf, &settings);
        assert!(src.iter().zip(&buf).all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn gain_scales_signal() {
        let mut p = Processor::new(48_000);
        let settings = DspSettings {
            gain_db: 6.0,
            limiter_enabled: false,
            ..DspSettings::default()
        };
        let mut buf = sine(0.1, 4_800);
        p.process_with(&mut buf, &settings);
        assert!((peak(&buf) - 0.1 * db_to_lin(6.0)).abs() < 1e-3, "peak {}", peak(&buf));
    }
}
