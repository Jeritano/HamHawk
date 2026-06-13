// FFI shim around ft8_lib (kgoba/ft8_lib, MIT). Wraps the monitor + decode flow
// (ported from demo/decode_ft8.c) and GFSK synthesis (from demo/gen_ft8.c) behind
// two simple C entry points consumed by Rust over FFI.

#include "hh_ft8.h"

#include <ft8/decode.h>
#include <ft8/encode.h>
#include <ft8/message.h>
#include <ft8/constants.h>
#include <common/monitor.h>

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---- callsign hash table (ported from demo/decode_ft8.c) ----

#define CALLSIGN_HASHTABLE_SIZE 256

static struct
{
    char callsign[12];
    uint32_t hash;
} callsign_hashtable[CALLSIGN_HASHTABLE_SIZE];

static int callsign_hashtable_size;

static void hashtable_init(void)
{
    callsign_hashtable_size = 0;
    memset(callsign_hashtable, 0, sizeof(callsign_hashtable));
}

static void hashtable_add(const char* callsign, uint32_t hash)
{
    uint16_t hash10 = (hash >> 12) & 0x3FFu;
    int idx_hash = (hash10 * 23) % CALLSIGN_HASHTABLE_SIZE;
    while (callsign_hashtable[idx_hash].callsign[0] != '\0')
    {
        if (((callsign_hashtable[idx_hash].hash & 0x3FFFFFu) == hash) &&
            (0 == strcmp(callsign_hashtable[idx_hash].callsign, callsign)))
        {
            callsign_hashtable[idx_hash].hash &= 0x3FFFFFu;
            return;
        }
        idx_hash = (idx_hash + 1) % CALLSIGN_HASHTABLE_SIZE;
    }
    callsign_hashtable_size++;
    strncpy(callsign_hashtable[idx_hash].callsign, callsign, 11);
    callsign_hashtable[idx_hash].callsign[11] = '\0';
    callsign_hashtable[idx_hash].hash = hash;
}

static bool hashtable_lookup(ftx_callsign_hash_type_t hash_type, uint32_t hash, char* callsign)
{
    uint8_t hash_shift = (hash_type == FTX_CALLSIGN_HASH_10_BITS) ? 12 : (hash_type == FTX_CALLSIGN_HASH_12_BITS ? 10 : 0);
    uint16_t hash10 = (hash >> (12 - hash_shift)) & 0x3FFu;
    int idx_hash = (hash10 * 23) % CALLSIGN_HASHTABLE_SIZE;
    while (callsign_hashtable[idx_hash].callsign[0] != '\0')
    {
        if (((callsign_hashtable[idx_hash].hash & 0x3FFFFFu) >> hash_shift) == hash)
        {
            strcpy(callsign, callsign_hashtable[idx_hash].callsign);
            return true;
        }
        idx_hash = (idx_hash + 1) % CALLSIGN_HASHTABLE_SIZE;
    }
    callsign[0] = '\0';
    return false;
}

static ftx_callsign_hash_interface_t hash_if = {
    .lookup_hash = hashtable_lookup,
    .save_hash = hashtable_add
};

// ---- decode ----

#define HH_MIN_SCORE 10
#define HH_MAX_CANDIDATES 140
#define HH_LDPC_ITERS 25
#define HH_MAX_DECODED 50
#define HH_FREQ_OSR 2
#define HH_TIME_OSR 2

int hh_ft8_decode(const float* samples, int num_samples, int sample_rate,
                  int is_ft4, char* out_text, int text_stride,
                  float* out_snr, float* out_freq, int max_msgs)
{
    if (!samples || num_samples <= 0 || !out_text || max_msgs <= 0)
        return -1;

    hashtable_init();

    monitor_config_t cfg = {
        .f_min = 100.0f,
        .f_max = 3000.0f,
        .sample_rate = sample_rate,
        .time_osr = HH_TIME_OSR,
        .freq_osr = HH_FREQ_OSR,
        .protocol = is_ft4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8
    };

    monitor_t mon;
    monitor_init(&mon, &cfg);

    // Feed the audio one symbol-block at a time until the waterfall is full.
    int offset = 0;
    while (offset + mon.block_size <= num_samples && mon.wf.num_blocks < mon.wf.max_blocks)
    {
        monitor_process(&mon, samples + offset);
        offset += mon.block_size;
    }

    ftx_candidate_t candidate_list[HH_MAX_CANDIDATES];
    int num_candidates = ftx_find_candidates(&mon.wf, HH_MAX_CANDIDATES, candidate_list, HH_MIN_SCORE);

    ftx_message_t decoded[HH_MAX_DECODED];
    ftx_message_t* decoded_hashtable[HH_MAX_DECODED];
    for (int i = 0; i < HH_MAX_DECODED; ++i)
        decoded_hashtable[i] = NULL;

    int count = 0;
    for (int idx = 0; idx < num_candidates && count < max_msgs; ++idx)
    {
        const ftx_candidate_t* cand = &candidate_list[idx];
        float freq_hz = (mon.min_bin + cand->freq_offset + (float)cand->freq_sub / mon.wf.freq_osr) / mon.symbol_period;

        ftx_message_t message;
        ftx_decode_status_t status;
        if (!ftx_decode_candidate(&mon.wf, cand, HH_LDPC_ITERS, &message, &status))
            continue;

        // De-duplicate via the message hash.
        int idx_hash = message.hash % HH_MAX_DECODED;
        bool found_empty = false, found_dup = false;
        do
        {
            if (decoded_hashtable[idx_hash] == NULL)
                found_empty = true;
            else if (decoded_hashtable[idx_hash]->hash == message.hash &&
                     0 == memcmp(decoded_hashtable[idx_hash]->payload, message.payload, sizeof(message.payload)))
                found_dup = true;
            else
                idx_hash = (idx_hash + 1) % HH_MAX_DECODED;
        } while (!found_empty && !found_dup);

        if (!found_empty)
            continue;

        memcpy(&decoded[idx_hash], &message, sizeof(message));
        decoded_hashtable[idx_hash] = &decoded[idx_hash];

        char text[FTX_MAX_MESSAGE_LENGTH];
        ftx_message_offsets_t offsets;
        if (ftx_message_decode(&message, &hash_if, text, &offsets) != FTX_MESSAGE_RC_OK)
            continue;

        char* dst = out_text + (size_t)count * text_stride;
        strncpy(dst, text, text_stride - 1);
        dst[text_stride - 1] = '\0';
        if (out_snr)
            out_snr[count] = cand->score * 0.5f;
        if (out_freq)
            out_freq[count] = freq_hz;
        count++;
    }

    monitor_free(&mon);
    return count;
}

// ---- encode (GFSK synthesis, ported from demo/gen_ft8.c) ----

static void gfsk_pulse(int n_spsym, float symbol_bt, float* pulse)
{
    for (int i = 0; i < 3 * n_spsym; ++i)
    {
        float t = i / (float)n_spsym - 1.5f;
        float arg1 = (float)(M_PI * 0.83255461115769769f * symbol_bt * (t + 0.5f));
        float arg2 = (float)(M_PI * 0.83255461115769769f * symbol_bt * (t - 0.5f));
        pulse[i] = (erff(arg1) - erff(arg2)) / 2.0f;
    }
}

static void synth_gfsk(const uint8_t* symbols, int n_sym, float f0, float symbol_bt,
                       float symbol_period, int signal_rate, float* signal)
{
    int n_spsym = (int)(0.5f + signal_rate * symbol_period);
    int n_wave = n_sym * n_spsym;
    float hmod = 1.0f;
    float dphi_peak = (float)(2 * M_PI * hmod / n_spsym);

    float* dphi = (float*)malloc((n_wave + 2 * n_spsym) * sizeof(float));
    for (int i = 0; i < n_wave + 2 * n_spsym; ++i)
        dphi[i] = (float)(2 * M_PI * f0 / signal_rate);

    float* pulse = (float*)malloc(3 * n_spsym * sizeof(float));
    gfsk_pulse(n_spsym, symbol_bt, pulse);

    for (int i = 0; i < n_sym; ++i)
    {
        int ib = i * n_spsym;
        for (int j = 0; j < 3 * n_spsym; ++j)
            dphi[j + ib] += dphi_peak * symbols[i] * pulse[j];
    }
    for (int j = 0; j < 2 * n_spsym; ++j)
    {
        dphi[j] += dphi_peak * pulse[j + n_spsym] * symbols[0];
        dphi[j + n_sym * n_spsym] += dphi_peak * pulse[j] * symbols[n_sym - 1];
    }

    float phi = 0;
    for (int k = 0; k < n_wave; ++k)
    {
        signal[k] = sinf(phi);
        phi = fmodf(phi + dphi[k + n_spsym], (float)(2 * M_PI));
    }

    int n_ramp = n_spsym / 8;
    for (int i = 0; i < n_ramp; ++i)
    {
        float env = (1 - cosf((float)(2 * M_PI * i / (2 * n_ramp)))) / 2;
        signal[i] *= env;
        signal[n_wave - 1 - i] *= env;
    }

    free(dphi);
    free(pulse);
}

int hh_ft8_encode(const char* message, int is_ft4, float* out_samples,
                  int max_samples, int sample_rate, float f0)
{
    if (!message || !out_samples || max_samples <= 0)
        return -1;

    hashtable_init();

    ftx_message_t msg;
    ftx_message_init(&msg);
    if (ftx_message_encode(&msg, &hash_if, message) != FTX_MESSAGE_RC_OK)
        return -2;

    int num_tones = is_ft4 ? FT4_NN : FT8_NN;
    float symbol_period = is_ft4 ? FT4_SYMBOL_PERIOD : FT8_SYMBOL_PERIOD;
    float symbol_bt = is_ft4 ? 1.0f : 2.0f;
    float slot_time = is_ft4 ? FT4_SLOT_TIME : FT8_SLOT_TIME;

    uint8_t tones[FT4_NN];
    if (is_ft4)
        ft4_encode(msg.payload, tones);
    else
        ft8_encode(msg.payload, tones);

    int num_samples = (int)(0.5f + num_tones * symbol_period * sample_rate);
    int num_silence = ((int)(slot_time * sample_rate) - num_samples) / 2;
    if (num_silence < 0)
        num_silence = 0;
    int total = num_samples + 2 * num_silence;
    if (total > max_samples)
        return -3;

    for (int i = 0; i < total; ++i)
        out_samples[i] = 0.0f;

    synth_gfsk(tones, num_tones, f0, symbol_bt, symbol_period, sample_rate,
               out_samples + num_silence);
    return total;
}
