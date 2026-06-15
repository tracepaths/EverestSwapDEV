/*
    This file is part of Octra Wallet (webcli).

    Octra Wallet is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    Octra Wallet is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Octra Wallet.  If not, see <http://www.gnu.org/licenses/>.

    This program is released under the GPL with the additional exemption
    that compiling, linking, and/or using OpenSSL is allowed.
    You are free to remove this exemption from derived works.

    Copyright 2025-2026 Octra Labs
              2025-2026 David A.
              2025-2026 Alex T.
              2025-2026 Vadim S.
              2025-2026 Julia L.
*/

#pragma once
#include <string>
#include <vector>
#include <mutex>
#include <shared_mutex>
#include <leveldb/db.h>
#include <leveldb/write_batch.h>
#include "json.hpp"

class TxCache {
    leveldb::DB* db_ = nullptr;
    std::string path_;
    mutable std::shared_mutex mtx_;

    bool open_u(const std::string& path) {
        path_ = path;
        leveldb::Options opts;
        opts.create_if_missing = true;
        auto st = leveldb::DB::Open(opts, path, &db_);
        return st.ok();
    }

    void close_u() { delete db_; db_ = nullptr; path_.clear(); }

    std::string get_u(const std::string& key) {
        std::string val;
        if (db_ && db_->Get(leveldb::ReadOptions(), key, &val).ok()) return val;
        return "";
    }

    void put_u(const std::string& key, const std::string& val) {
        if (db_) db_->Put(leveldb::WriteOptions(), key, val);
    }

public:
    bool open(const std::string& path) {
        std::unique_lock<std::shared_mutex> lk(mtx_);
        return open_u(path);
    }

    void close() {
        std::unique_lock<std::shared_mutex> lk(mtx_);
        close_u();
    }

    ~TxCache() { close_u(); }

    leveldb::DB* detach() {
        std::unique_lock<std::shared_mutex> lk(mtx_);
        leveldb::DB* db = db_;
        db_ = nullptr;
        path_.clear();
        return db;
    }

    void clear() {
        std::unique_lock<std::shared_mutex> lk(mtx_);
        std::string p = path_;
        close_u();
        if (!p.empty()) leveldb::DestroyDB(p, leveldb::Options());
        if (!p.empty()) open_u(p);
    }

    void ensure_rpc(const std::string& rpc_url) {
        auto stored = get("meta:rpc_url");
        if (stored != rpc_url) {
            if (!stored.empty())
                fprintf(stderr, "txcache: rpc mismatch (%s != %s), clearing\n",
                        stored.c_str(), rpc_url.c_str());
            clear();
            put("meta:rpc_url", rpc_url);
        }
    }

    void ensure_schema(const std::string& schema) {
        auto stored = get("meta:schema");
        if (stored != schema) {
            if (!stored.empty())
                fprintf(stderr, "txcache: schema mismatch (%s != %s), clearing\n",
                        stored.c_str(), schema.c_str());
            clear();
            put("meta:schema", schema);
        }
    }

    void put(const std::string& key, const std::string& val) {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        put_u(key, val);
    }

    std::string get(const std::string& key) {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        return get_u(key);
    }

    int get_total(const std::string& addr) {
        auto v = get("total:" + addr);
        return v.empty() ? 0 : std::stoi(v);
    }

    void set_total(const std::string& addr, int total) {
        put("total:" + addr, std::to_string(total));
    }

    void store_tx(const std::string& addr, const nlohmann::json& tx) {
        std::string hash = tx.value("hash", "");
        if (hash.empty() || addr.empty()) return;
        std::shared_lock<std::shared_mutex> lk(mtx_);
        put_u("tx:" + hash, tx.dump());
        double ts = tx.value("timestamp", 0.0);
        char idx[128];
        snprintf(idx, sizeof(idx), "idx:%s:%020.6f:%s", addr.c_str(), 9999999999.0 - ts, hash.c_str());
        put_u(idx, hash);
    }

    void store_txs(const std::string& addr, const nlohmann::json& txs) {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        if (!db_) return;
        leveldb::WriteBatch batch;
        for (auto& tx : txs) {
            std::string hash = tx.value("hash", "");
            if (hash.empty() || addr.empty()) continue;
            batch.Put("tx:" + hash, tx.dump());
            double ts = tx.value("timestamp", 0.0);
            char idx[192];
            snprintf(idx, sizeof(idx), "idx:%s:%020.6f:%s", addr.c_str(), 9999999999.0 - ts, hash.c_str());
            batch.Put(idx, hash);
        }
        db_->Write(leveldb::WriteOptions(), &batch);
    }

    nlohmann::json load_page(const std::string& addr, int limit, int offset) {
        nlohmann::json result = nlohmann::json::array();
        std::shared_lock<std::shared_mutex> lk(mtx_);
        if (!db_ || addr.empty()) return result;
        std::string prefix = "idx:" + addr + ":";
        auto it = db_->NewIterator(leveldb::ReadOptions());
        int pos = 0;
        for (it->Seek(prefix); it->Valid(); it->Next()) {
            auto k = it->key().ToString();
            if (k.compare(0, prefix.size(), prefix) != 0) break;
            if (pos < offset) { pos++; continue; }
            auto hash = it->value().ToString();
            std::string val;
            if (db_->Get(leveldb::ReadOptions(), "tx:" + hash, &val).ok()) {
                try { result.push_back(nlohmann::json::parse(val)); } catch (...) {}
            }
            pos++;
            if (limit > 0 && (pos - offset) >= limit) break;
        }
        delete it;
        return result;
    }

    int count_idx(const std::string& addr) {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        if (!db_ || addr.empty()) return 0;
        std::string prefix = "idx:" + addr + ":";
        int n = 0;
        auto it = db_->NewIterator(leveldb::ReadOptions());
        for (it->Seek(prefix); it->Valid(); it->Next()) {
            if (it->key().ToString().compare(0, prefix.size(), prefix) != 0) break;
            n++;
        }
        delete it;
        return n;
    }

    bool has_tx(const std::string& hash) {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        std::string val;
        return db_ && db_->Get(leveldb::ReadOptions(), "tx:" + hash, &val).ok();
    }

    bool is_open() const {
        std::shared_lock<std::shared_mutex> lk(mtx_);
        return db_ != nullptr;
    }
};