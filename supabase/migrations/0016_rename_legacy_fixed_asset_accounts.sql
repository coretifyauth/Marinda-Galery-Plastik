-- Rename leftover fixed-asset COA accounts from the retired "CV Roti Barokah" bakery
-- story (Peralatan Oven / Kendaraan Motor) to match the current story, Toko Plastik
-- Makmur Jaya (docs/story/company-profile.md): Rak Display Toko (straight-line) and
-- Mobil Pickup Antar Barang (declining balance). Name-only update — codes, category,
-- is_contra, parent_id, and every existing account_id reference (journal_lines,
-- fixed_assets) are untouched, so this carries zero risk to posted data.

update accounts set name = 'Rak Display Toko' where code = '1610';
update accounts set name = 'Akumulasi Penyusutan Rak Display Toko' where code = '1630';
update accounts set name = 'Beban Penyusutan Rak Display Toko' where code = '5600';

update accounts set name = 'Mobil Pickup Antar Barang' where code = '1620';
update accounts set name = 'Akumulasi Penyusutan Mobil Pickup Antar Barang' where code = '1640';
update accounts set name = 'Beban Penyusutan Mobil Pickup Antar Barang' where code = '5610';
