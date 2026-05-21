document.addEventListener('DOMContentLoaded', () => {
    // ── Mobile Sidebar Toggle ──
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebar = document.getElementById('sidebar');
    const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');

    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', openSidebar);
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);

    // Close sidebar when a nav link is clicked (mobile)
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 768) closeSidebar();
        });
    });

    let globalData = [];
    let filteredData = [];
    let boqData = []; // Store BOQ Data
    let duplicateInfo = { poles: 0, buildings: 0, poleDuplicates: [], buildingDuplicates: [] };
    let viewMode = 'field'; // 'field' or 'boq'
    let currentPage = 1;
    const rowsPerPage = 25;
    let map = null;
    let markersLayer = null;
    let boundaryLayer = null;       // Lagos + UT polygon layers
    let utLabelLayer = null;        // UT name labels (permanent)
    let htFeederLayer = null;       // Shomolu HT feeder polylines
    let issLayer = null;            // Injection Substation point markers
    let tcnLayer = null;            // TCN transmission station markers
    let boundariesLoaded = false;   // one-time load guard
    let utBoundsCache = null;       // UT-only bounds (fallback when no data)
    let mapInitiallyFitted = false; // first-render fit guard
    let pulseTimer = null;          // setTimeout id for pulse auto-stop

    // Generate a visually distinct color for each UT via golden-angle HSL.
    // 54 UTs need 54 colors that are easy to tell apart at a glance.
    const utColorFor = (i) => `hsl(${((i * 137.508) % 360).toFixed(0)}, 72%, 52%)`;

    // ── Multi-Select Dropdown Component ──
    const multiSelects = {};

    class MultiSelect {
        constructor(selectEl, opts = {}) {
            this.selectEl = selectEl;
            this.id = selectEl.id;
            this.allValue = opts.allValue ?? 'All';
            this.allLabel = selectEl.options[0]?.textContent || 'All';
            this.selectedValues = new Set();
            this.onChange = opts.onChange || (() => {});
            this._build();
        }

        _build() {
            this.selectEl.style.display = 'none';

            this.wrapper = document.createElement('div');
            this.wrapper.className = 'multi-select-wrapper';
            this.selectEl.parentNode.insertBefore(this.wrapper, this.selectEl.nextSibling);

            this.trigger = document.createElement('div');
            this.trigger.className = 'multi-select-trigger';
            this.trigger.textContent = this.allLabel;
            this.wrapper.appendChild(this.trigger);

            // Append dropdown to body so it escapes overflow:auto parents
            this.dropdown = document.createElement('div');
            this.dropdown.className = 'multi-select-dropdown';
            document.body.appendChild(this.dropdown);

            this.trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggle();
            });

            document.addEventListener('click', (e) => {
                if (!this.wrapper.contains(e.target) && !this.dropdown.contains(e.target)) this._close();
            });

            window.addEventListener('scroll', () => { if (this._isOpen) this._positionDropdown(); }, true);
            window.addEventListener('resize', () => { if (this._isOpen) this._positionDropdown(); });

            this._isOpen = false;
            this.refresh();
        }

        refresh() {
            this.dropdown.innerHTML = '';
            const options = [...this.selectEl.options].slice(1); // skip "All" option

            // Search box (show for 8+ items)
            if (options.length >= 8) {
                this.searchInput = document.createElement('input');
                this.searchInput.className = 'multi-select-search';
                this.searchInput.placeholder = 'Search...';
                this.searchInput.addEventListener('input', () => this._filterOptions());
                this.searchInput.addEventListener('click', (e) => e.stopPropagation());
                this.dropdown.appendChild(this.searchInput);
            } else {
                this.searchInput = null;
            }

            // Select All / Clear buttons
            const actions = document.createElement('div');
            actions.className = 'multi-select-actions';
            const btnAll = document.createElement('button');
            btnAll.textContent = 'Select All';
            btnAll.addEventListener('click', (e) => { e.stopPropagation(); this._selectAll(); });
            const btnClear = document.createElement('button');
            btnClear.textContent = 'Clear';
            btnClear.addEventListener('click', (e) => { e.stopPropagation(); this._clearAll(); });
            actions.appendChild(btnAll);
            actions.appendChild(btnClear);
            this.dropdown.appendChild(actions);

            this.optionContainer = document.createElement('div');
            this.dropdown.appendChild(this.optionContainer);

            // Remove stale values no longer in options
            const availableValues = new Set(options.map(o => o.value));
            this.selectedValues = new Set([...this.selectedValues].filter(v => availableValues.has(v)));

            options.forEach(opt => {
                const label = document.createElement('label');
                label.className = 'multi-select-option';
                label.dataset.value = opt.value;
                label.dataset.text = opt.textContent.toLowerCase();

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = opt.value;
                cb.checked = this.selectedValues.has(opt.value);

                const span = document.createElement('span');
                span.textContent = opt.textContent;

                label.appendChild(cb);
                label.appendChild(span);
                this.optionContainer.appendChild(label);

                cb.addEventListener('change', () => {
                    if (cb.checked) this.selectedValues.add(opt.value);
                    else this.selectedValues.delete(opt.value);
                    this._updateDisplay();
                    this.onChange();
                });
            });

            this._updateDisplay();
        }

        _filterOptions() {
            const query = (this.searchInput?.value || '').toLowerCase();
            this.optionContainer.querySelectorAll('.multi-select-option').forEach(el => {
                el.classList.toggle('hidden', query && !el.dataset.text.includes(query));
            });
        }

        _selectAll() {
            this.optionContainer.querySelectorAll('.multi-select-option:not(.hidden) input').forEach(cb => {
                cb.checked = true;
                this.selectedValues.add(cb.value);
            });
            this._updateDisplay();
            this.onChange();
        }

        _clearAll() {
            this.selectedValues.clear();
            this.optionContainer.querySelectorAll('input').forEach(cb => cb.checked = false);
            this._updateDisplay();
            this.onChange();
        }

        _updateDisplay() {
            if (this.selectedValues.size === 0) {
                this.trigger.textContent = this.allLabel;
                this.trigger.classList.remove('has-selection');
            } else if (this.selectedValues.size === 1) {
                const val = [...this.selectedValues][0];
                const opt = [...this.selectEl.options].find(o => o.value === val);
                this.trigger.textContent = opt ? opt.textContent : val;
                this.trigger.classList.add('has-selection');
            } else {
                this.trigger.textContent = `${this.selectedValues.size} selected`;
                this.trigger.classList.add('has-selection');
            }
        }

        _positionDropdown() {
            const rect = this.trigger.getBoundingClientRect();
            this.dropdown.style.top = (rect.bottom + 2) + 'px';
            this.dropdown.style.left = rect.left + 'px';
            this.dropdown.style.minWidth = Math.max(rect.width, 180) + 'px';
        }

        _toggle() {
            // Close all other open dropdowns
            for (const ms of Object.values(multiSelects)) {
                if (ms !== this && ms._isOpen) ms._close();
            }
            if (this._isOpen) {
                this._close();
            } else {
                this._isOpen = true;
                this._positionDropdown();
                this.dropdown.style.display = 'block';
                this.wrapper.classList.add('open');
                if (this.searchInput) {
                    this.searchInput.value = '';
                    this._filterOptions();
                    this.searchInput.focus();
                }
            }
        }

        _close() {
            this._isOpen = false;
            this.dropdown.style.display = 'none';
            this.wrapper.classList.remove('open');
        }

        /** Returns array of selected values, or null if "All" (nothing selected) */
        getValues() {
            return this.selectedValues.size === 0 ? null : [...this.selectedValues];
        }

        isAll() { return this.selectedValues.size === 0; }

        reset() {
            this.selectedValues.clear();
            this.refresh();
        }
    }

    function initMultiSelects() {
        const filterConfigs = {
            vendorFilter:   { onChange: handleVendorChange },
            buFilter:       { onChange: applyFilters },
            utFilter:       { onChange: applyFilters },
            userFilter:     { onChange: applyFilters },
            feederFilter:   { onChange: () => { updateDTOptions(); applyFilters(); } },
            dtFilter:       { onChange: () => { updateUpriserOptions(); applyFilters(); } },
            upriserFilter:  { onChange: applyFilters },
            materialFilter: { allValue: '', onChange: applyFilters },
            dateFilter:     { onChange: applyFilters },
        };

        for (const [id, cfg] of Object.entries(filterConfigs)) {
            const el = document.getElementById(id);
            if (el) {
                multiSelects[id] = new MultiSelect(el, cfg);
            }
        }
    }

    function refreshAllMultiSelects() {
        for (const ms of Object.values(multiSelects)) {
            ms.refresh();
        }
    }

    // Helper to infer vendor from user
    function inferVendor(user) {
        // Based on provided documents
        const etcUsers = new Set([
            'aoluwatobi', 'adamilola2', 'aahmed2', 'aogundehin', 'aadebisi',
            'aprecious', 'aabrola1', 'aayinlani', 'aedozie', 'aabrola',
            'aosimen', 'aayogu', 'agbolahan', 'apatrick', 'aoluwadamilare'
        ]);
        const jesomUsers = new Set([
            'sbolaji', 'omukaila', 'ojamiu', 'jemmanuel', 'foluwafisayo',
            'yakin', 'ysalaudeen', 'shodimu', 'ajemmanuel', 'ajumobi',
            'adamilare'
        ]);
        // Ikeja Electric users — matched by system username (as stored in the data)
        const ikejaUsers = new Set([
            // Original display-name format (legacy fallback)
            'kamoru adebayo', 'taiwo tope', 'rasaq akinloye', 'von ifeanyi', 'olatunji sunday',
            'williams adegoke', 'olumide moses', 'david oluwaseun', 'douglas owoicho', 'uche ifeanyichukwu',
            'dan ekpe', 'odeniya taiwo', 'ismail akintola', 'richard abayomi', 'oyinloye john',
            'rufus oluwasoji', 'emmma ikechukwu', 'goddey akhimien', 'stanley madu', 'moses akpan',
            'sanuolu julius', 'daniel uche', 'olaiya okikioluwa', 'michael ikhuoso', 'wasiu omotayo',
            'yusuf adewale', 'ola emmanuel', 'nnadi benjamin', 'akinmayowa oluwaseun', 'olabode taofik',
            'matthew omolayo', 'demilade olujide', 'lukmon kugbayi', 'kehinde erinle', 'timileyin solomon',
            'adeyemi alaba', 'patrick ralph', 'timileyin adegolu', 'bayo ayodele', 'forcados johnson',
            'adeyemo temidayo', 'ojonumi samuel', 'salaudeen abdulmuiz', 'emmanuel obasi', 'opeyemi adeagbo',
            'ajao mustapha', 'adesanya adegbenro', 'aladesanmi luqman', 'ugochukwu stephen', 'john utibe',
            'olumide olawaiye', 'adegbenro adeola', 'chukwudi fonatius', 'balogun bankole', 'gbenga abefe',
            'moses adedayo', 'somadina martins', 'akande adbulwasiu', 'solomon thompson', 'alawode omotoyosi',
            'akinbode quadri', 'alowolodu julius', 'david gabriel', 'chioma ogochukwu', 'mustapha ajao',
            'chika ejindu', 'osaretin edobor', 'olumuyiwa oladapo', 'eunice odiana',
            'john mark', 'akinyele ezekiel', 'pius onwubiko',
            // System usernames from the field data (as they actually appear in the dataset)
            'kadebayo', 'ttope', 'rakinloye', 'vifeanyi', 'osunday', 'wadegoke', 'omoses',
            'doluwaseun', 'dowoicho', 'uifeanyichukwu', 'dekpe', 'odtaiwo', 'iakintola',
            'rabayomi', 'ojohn', 'roluwasoji', 'eikechukwu', 'gakhimien', 'smadu', 'makpan',
            'msanuolu', 'mdaniel', 'molaiya', 'mmichael', 'mwasiu', 'myusuf', 'mola', 'mnnadi',
            'makinmayowa', 'molabode', 'mmatthew', 'mdemilade', 'lkugbayi', 'kerinle',
            'tsolomon', 'aalaba', 'pralph', 'tadegolu', 'bayodele', 'fjohnson', 'atemidayo',
            'osamuel', 'sabdulmuiz', 'eobasi', 'oadeagbo', 'ajmustapha', 'dobademi',
            'aluqman', 'ustephen', 'jutibe', 'oolawaiye', 'aadeola', 'cfonatius', 'bbankole',
            'gabefe', 'madedayo', 'smartins', 'aabbul', 'sthompson', 'aomotoyo', 'aquadri',
            'ajulius', 'dgabriel', 'cogochukwu', 'majao', 'cejindu', 'oedobor', 'ooladapo',
            'dolujide', 'eodiana', 'jmark', 'aezekiel', 'ponwubiko'
        ]);

        if (etcUsers.has(user)) return 'ETC Workforce';
        if (jesomUsers.has(user)) return 'Jesom Technology';
        if (user && ikejaUsers.has(user.toLowerCase())) return 'Ikeja Electric';

        // Fallback heuristic: Many ETC users start with 'a' followed by a name
        if (user && user.startsWith('a') && user.length > 3) return 'ETC Workforce';

        // Default unmapped users to Ikeja Electric (no 'Other' classification)
        return 'Ikeja Electric';
    }

    // User Name Mapping
    const userFullNames = {
        // ETC Workforce users
        'aosimen': 'Osimen Faith',
        'aayogu': 'Ayogu Peace',
        'aoluwatobi': 'Oluwatobi Akingbade',
        'aabiola': 'Abiola Oluwadamilola',
        'aedozie': 'Edozie Njoku',
        'aprecious': 'Precious Ema',
        'agbolahan': 'Gbolahan Oguniyi',
        'aahmed2': 'Ajayi Ahmed',
        'aadebisi': 'Adebisi Kabiru',
        'aogundehin': 'Ogundehin Deborah',
        'aabiola1': 'Abiola Makinde',
        'aayokanmi': 'Agba Ayokunmi',
        'adamilola2': 'Awotipe Damilola',
        'aoluwadamilare': 'Akintola Oluwadamilare',
        'adamilare': 'Ayorinde Damilare',
        'apatrick': 'Emmanuel Patrick',
        // Jesom Technology users
        'omukaila': 'Olusanjo Mukaila',
        'sbolaji': 'Shodimu Bolaji',
        'ojamiu': 'Oyebanjo Jamiu',
        'ajemmanuel': 'Ajumobi Emmanuel',
        'foluwafisayo': 'Famoroti Oluwafisayo',
        'yakin': 'Yinusa Akin',
        'ysalaudeen': 'Yusuf Salaudeen',
        'shodimu': 'Shodimu Bolaji',
        'ajuliet2': 'Ugorchi Amadi',
        'alucky': 'Lucky Okwuonu',
        // Ikeja Electric users — system username → Full Display Name
        'kadebayo': 'Kamoru Adebayo',
        'ttope': 'Taiwo Tope',
        'rakinloye': 'Rasaq Akinloye',
        'vifeanyi': 'Von Ifeanyi',
        'osunday': 'Olatunji Sunday',
        'wadegoke': 'Williams Adegoke',
        'omoses': 'Olumide Moses',
        'doluwaseun': 'David Oluwaseun',
        'dowoicho': 'Douglas Owoicho',
        'uifeanyichukwu': 'Uche Ifeanyichukwu',
        'dekpe': 'Dan Ekpe',
        'odtaiwo': 'Odeniya Taiwo',
        'iakintola': 'Ismail Akintola',
        'rabayomi': 'Richard Abayomi',
        'ojohn': 'Oyinloye John',
        'roluwasoji': 'Rufus Oluwasoji',
        'eikechukwu': 'Emma Ikechukwu',
        'gakhimien': 'Goddey Akhimien',
        'smadu': 'Stanley Madu',
        'makpan': 'Moses Akpan',
        'msanuolu': 'Sanuolu Julius',
        'mdaniel': 'Daniel Uche',
        'molaiya': 'Olaiya Okikioluwa',
        'mmichael': 'Michael Ikhuoso',
        'mwasiu': 'Wasiu Omotayo',
        'myusuf': 'Yusuf Adewale',
        'mola': 'Ola Emmanuel',
        'mnnadi': 'Nnadi Benjamin',
        'makinmayowa': 'Akinmayowa Oluwaseun',
        'molabode': 'Olabode Taofik',
        'mmatthew': 'Matthew Omolayo',
        'mdemilade': 'Demilade Olujide',
        'lkugbayi': 'Lukmon Kugbayi',
        'kerinle': 'Kehinde Erinle',
        'tsolomon': 'Timileyin Solomon',
        'aalaba': 'Adeyemi Alaba',
        'pralph': 'Patrick Ralph',
        'tadegolu': 'Timileyin Adegolu',
        'bayodele': 'Bayo Ayodele',
        'fjohnson': 'Forcados Johnson',
        'atemidayo': 'Adeyemo Temidayo',
        'osamuel': 'Ojonumi Samuel',
        'sabdulmuiz': 'Salaudeen Abdulmuiz',
        'eobasi': 'Emmanuel Obasi',
        'oadeagbo': 'Opeyemi Adeagbo',
        'ajmustapha': 'Ajao Mustapha',
        'dobademi': 'Adesanya Adegbenro',
        'aluqman': 'Aladesanmi Luqman',
        'ustephen': 'Ugochukwu Stephen',
        'jutibe': 'John Utibe',
        'oolawaiye': 'Olumide Olawaiye',
        'aadeola': 'Adegbenro Adeola',
        'cfonatius': 'Chukwudi Fonatius',
        'bbankole': 'Balogun Bankole',
        'gabefe': 'Gbenga Abefe',
        'madedayo': 'Moses Adedayo',
        'smartins': 'Somadina Martins',
        'aabbul': 'Akande Abdulwasiu',
        'sthompson': 'Solomon Thompson',
        'aomotoyo': 'Alawode Omotoyosi',
        'aquadri': 'Akinbode Quadri',
        'ajulius': 'Alowolodu Julius',
        'dgabriel': 'David Gabriel',
        'cogochukwu': 'Chioma Ogochukwu',
        'majao': 'Mustapha Ajao',
        'cejindu': 'Chika Ejindu',
        'oedobor': 'Osaretin Edobor',
        'ooladapo': 'Olumuyiwa Oladapo',
        'dolujide': 'Demilade Olujide',
        'eodiana': 'Eunice Odiana',
        'jmark': 'John Mark',
        'aezekiel': 'Akinyele Ezekiel',
        'ponwubiko': 'Pius Onwubiko'
    };

    // Also register Ikeja Electric display names (for legacy data stored as full names)
    [
        'Kamoru Adebayo', 'Taiwo Tope', 'Rasaq Akinloye', 'Von Ifeanyi', 'Olatunji Sunday',
        'Williams Adegoke', 'Olumide Moses', 'David Oluwaseun', 'Douglas Owoicho', 'Uche Ifeanyichukwu',
        'Dan Ekpe', 'Odeniya Taiwo', 'Ismail Akintola', 'Richard Abayomi', 'Oyinloye John',
        'Rufus Oluwasoji', 'Emma Ikechukwu', 'Goddey Akhimien', 'Stanley Madu', 'Moses Akpan',
        'Sanuolu Julius', 'Daniel Uche', 'Olaiya Okikioluwa', 'Michael Ikhuoso', 'Wasiu Omotayo',
        'Yusuf Adewale', 'Ola Emmanuel', 'Nnadi Benjamin', 'Akinmayowa Oluwaseun', 'Olabode Taofik',
        'Matthew Omolayo', 'Demilade Olujide', 'Lukmon Kugbayi', 'Kehinde Erinle', 'Timileyin Solomon',
        'Adeyemi Alaba', 'Patrick Ralph', 'Timileyin Adegolu', 'Bayo Ayodele', 'Forcados Johnson',
        'Adeyemo Temidayo', 'Ojonumi Samuel', 'Salaudeen Abdulmuiz', 'Emmanuel Obasi', 'Opeyemi Adeagbo',
        'Ajao Mustapha', 'Adesanya Adegbenro', 'Aladesanmi Luqman', 'Ugochukwu Stephen', 'John Utibe',
        'Olumide Olawaiye', 'Adegbenro Adeola', 'Chukwudi Fonatius', 'Balogun Bankole', 'Gbenga Abefe',
        'Moses Adedayo', 'Somadina Martins', 'Akande Abdulwasiu', 'Solomon Thompson', 'Alawode Omotoyosi',
        'Akinbode Quadri', 'Alowolodu Julius', 'David Gabriel', 'Chioma Ogochukwu', 'Mustapha Ajao',
        'Chika Ejindu', 'Osaretin Edobor', 'Olumuyiwa Oladapo', 'Eunice Odiana',
        'John Mark', 'Akinyele Ezekiel', 'Pius Onwubiko'
    ].forEach(name => {
        userFullNames[name.toLowerCase()] = name;
        userFullNames[name] = name;
    });

    // ─── Case-Insensitive Name Resolver ───────────────────────────────────────
    // The actual data stores usernames with mixed casing (e.g. 'KAdebayo', 'TTOPE').
    // Our dictionary keys are always lowercase, so a direct lookup fails.
    // This helper always resolves to the correct full display name.
    function getDisplayName(username) {
        if (!username) return '';
        // 1. Exact match (handles already-mapped full-name keys like 'Kamoru Adebayo')
        if (userFullNames[username]) return userFullNames[username];
        // 2. Lowercase match (handles all our standard lowercase keys)
        if (userFullNames[username.toLowerCase()]) return userFullNames[username.toLowerCase()];
        // 3. Fallback: return the raw username as-is
        return username;
    }

    // Detect duplicate SLRNs in the dataset and populate duplicateInfo
    function detectDuplicateSLRNs(data) {
        const poleCounts = {};
        const buildingCounts = {};

        data.forEach(item => {
            // Count pole SLRNs
            const poleSLRN = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
            if (poleSLRN) {
                poleCounts[poleSLRN] = (poleCounts[poleSLRN] || 0) + 1;
            }

            // Count building SLRNs (semicolon-separated)
            const bldgField = item["Associated Buildings SLRN"] || "";
            bldgField.split(";").forEach(s => {
                const trimmed = s.trim();
                if (trimmed) {
                    buildingCounts[trimmed] = (buildingCounts[trimmed] || 0) + 1;
                }
            });
        });

        const poleDuplicates = Object.entries(poleCounts).filter(([, count]) => count > 1);
        const buildingDuplicates = Object.entries(buildingCounts).filter(([, count]) => count > 1);

        duplicateInfo = {
            poles: poleDuplicates.length,
            buildings: buildingDuplicates.length,
            poleDuplicates: poleDuplicates,     // [[slrn, count], ...]
            buildingDuplicates: buildingDuplicates
        };

        if (poleDuplicates.length || buildingDuplicates.length) {
            console.warn(`[Data Quality] Duplicates detected — Pole SLRNs: ${poleDuplicates.length}, Building SLRNs: ${buildingDuplicates.length}`);
            if (poleDuplicates.length) console.table(poleDuplicates.slice(0, 20).map(([slrn, count]) => ({ SLRN: slrn, Occurrences: count })));
            if (buildingDuplicates.length) console.table(buildingDuplicates.slice(0, 20).map(([slrn, count]) => ({ SLRN: slrn, Occurrences: count })));
        }

        showDuplicateBanner();
    }

    // Show or hide the duplicate warning banner
    function showDuplicateBanner() {
        const banner = document.getElementById('duplicate-warning-banner');
        if (!banner) return;

        if (duplicateInfo.poles === 0 && duplicateInfo.buildings === 0) {
            banner.style.display = 'none';
            return;
        }

        const parts = [];
        if (duplicateInfo.poles > 0) parts.push(`${duplicateInfo.poles} duplicate Pole SLRN${duplicateInfo.poles > 1 ? 's' : ''}`);
        if (duplicateInfo.buildings > 0) parts.push(`${duplicateInfo.buildings} duplicate Building SLRN${duplicateInfo.buildings > 1 ? 's' : ''}`);

        const msgEl = document.getElementById('duplicate-warning-msg');
        if (msgEl) msgEl.textContent = `Data Quality Notice: ${parts.join(' and ')} detected. KPI counts reflect unique values only.`;
        banner.style.display = 'flex';
    }

    // Helper to simulate issues (for demo purposes)
    function simulateIssue(item) {
        // Deterministic 'random' based on ID or something, or just random
        // Weights: Good (70%), Broken (10%), Crooked (10%), Vandalised (5%), No ID (5%)
        const rand = Math.random();
        if (rand < 0.7) return 'Good Condition';
        if (rand < 0.8) return 'Broken Pole';
        if (rand < 0.9) return 'Crooked Pole';
        if (rand < 0.95) return 'Vandalised';
        return 'No ID';
    }

    // Initialize Dashboard
    // Initialize Dashboard - Auto Fetch
    // CRITICAL: To update data, upload your file to Supabase as "converted_data_latest.json".
    // Do NOT change this code. Just overwrite the file in Supabase.
    const fieldDataUrls = [
        "https://mvfguayhttcdeibomjru.supabase.co/storage/v1/object/public/dashboard-assets/converted_data_latest.json",
        "https://zgypltdsqjhftnxadunu.supabase.co/storage/v1/object/public/dashboard-assets/converted_data_latest.json"
    ];

    const boqDataUrls = [
        "https://mvfguayhttcdeibomjru.supabase.co/storage/v1/object/public/dashboard-assets/BOQ-IDB.json",
        "https://zgypltdsqjhftnxadunu.supabase.co/storage/v1/object/public/dashboard-assets/BOQ-IDB.json"
    ];

    const fetchWithFallback = async (primaryUrls, localPath, githubRawUrl) => {
        const urls = Array.isArray(primaryUrls) ? primaryUrls : [primaryUrls];
        for (const url of urls) {
            try {
                const res = await fetch(url + '?t=' + new Date().getTime());
                if (!res.ok) throw new Error(`Supabase response not ok (${url})`);
                return await res.json();
            } catch (error) {
                console.warn(`Fetch from ${url} failed, trying next source...`, error);
            }
        }
        try {
            const resFallback = await fetch(localPath + '?t=' + new Date().getTime());
            if (!resFallback.ok) throw new Error('Fallback network response was not ok');
            return await resFallback.json();
        } catch (fallbackError) {
            console.warn(`Local fallback also failed, trying GitHub Raw Content...`, fallbackError);
            const resGithub = await fetch(githubRawUrl + '?t=' + new Date().getTime());
            if (!resGithub.ok) throw new Error('GitHub Raw network response was not ok');
            return await resGithub.json();
        }
    };

    Promise.all([
        fetchWithFallback(
            fieldDataUrls,
            './converted_data_latest.json',
            'https://raw.githubusercontent.com/Collins76/IDB-2.0-Assets-Tracking-Dashboard-V2/main/converted_data_latest.json'
        ),
        fetchWithFallback(
            boqDataUrls,
            './BOQ-IDB.json',
            'https://raw.githubusercontent.com/Collins76/IDB-2.0-Assets-Tracking-Dashboard-V2/main/BOQ-IDB.json'
        )
    ])
    .catch(error => {
        // True network / fetch failures land here — log silently, never
        // show a blocking alert. If data truly failed, the empty dashboard
        // is the clearest signal; developers can inspect the console.
        console.error('[Dashboard] Error fetching data from all sources:', error);
        return [null, null];
    })
    .then(([fieldData, boq]) => {
        if (!fieldData || !boq) {
            console.warn('[Dashboard] Skipping processing — data not available.');
            return;
        }
        // Some exports wrap the records under a sheet key (e.g. {"Sheet2": [...]})
        if (!Array.isArray(fieldData) && fieldData && typeof fieldData === 'object') {
            fieldData = fieldData.Sheet2 || fieldData.Sheet1 || Object.values(fieldData).find(Array.isArray) || [];
        }
        if (!Array.isArray(boq) && boq && typeof boq === 'object') {
            boq = boq.Sheet2 || boq.Sheet1 || Object.values(boq).find(Array.isArray) || [];
        }
        try {
            // Process Field Data
            fieldData.forEach(item => {
                item.Vendor_Name = inferVendor(item.User);
                if (!item.Issue_Type) item.Issue_Type = simulateIssue(item);
            });
            globalData = fieldData;
            filteredData = fieldData;

            // Detect duplicate SLRNs before rendering
            detectDuplicateSLRNs(fieldData);

            // Process BOQ Data
            boqData = boq;
            console.log("Total Data Loaded:", boqData.length);

            // Unlock Toggle
            const toggleWrapper = document.getElementById('viewModeWrapper');
            if (toggleWrapper) toggleWrapper.style.display = 'flex';

            populateFilters();
            updateDashboard();
            updateExecutiveSummary();

            document.querySelectorAll('.last-updated').forEach(el => {
                el.textContent = `Last Updated: ${new Date().toLocaleTimeString()}`;
            });
        } catch (processingError) {
            // Post-fetch runtime errors (rendering, filter population, etc.)
            // Log loudly but do NOT show the misleading "network connection" alert.
            console.error('Dashboard processing error after successful data load:', processingError);
        }
    });

    // Initialize multi-select filter dropdowns
    initMultiSelects();


    document.getElementById('viewModeToggle').addEventListener('change', handleViewModeToggle);
    document.getElementById('downloadExcel').addEventListener('click', downloadExcel);
    document.getElementById('dtSearchInput')?.addEventListener('input', () => {
        renderDTTable();
    });

    function downloadExcel() {
        if (!filteredData || filteredData.length === 0) {
            alert("No data available to download.");
            return;
        }

        const ws = XLSX.utils.json_to_sheet(filteredData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Assets");
        XLSX.writeFile(wb, "IDB_Monitor_Data.xlsx");
    }



    // AI Assistant Logic
    document.getElementById('ai-ask-btn').addEventListener('click', handleAIQuery);
    document.getElementById('ai-query').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAIQuery();
    });

    function handleAIQuery() {
        const rawQuery = document.getElementById('ai-query').value.trim();
        const query = rawQuery.toLowerCase();
        const responseEl = document.getElementById('ai-response');

        responseEl.classList.remove('visible');
        if (!query) return;

        // --- INTELLIGENCE HELPERS ---

        const getDistance = (a, b) => {
            if (a.length === 0) return b.length;
            if (b.length === 0) return a.length;
            const matrix = [];
            for (let i = 0; i <= b.length; i++) matrix[i] = [i];
            for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= a.length; j++) {
                    if (b.charAt(i - 1) === a.charAt(j - 1)) {
                        matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
                    }
                }
            }
            return matrix[b.length][a.length];
        };

        const findClosestEntity = (input, list) => {
            let bestMatch = null;
            let minDist = Infinity;
            list.forEach(item => {
                const dist = getDistance(input, item.toLowerCase());
                if (dist < minDist && dist < 4) {
                    minDist = dist;
                    bestMatch = item;
                }
            });
            return bestMatch;
        };

        const formatNum = (n) => typeof n === 'number' ? n.toLocaleString() : n;

        const getRunRate = (dataset) => {
            const dates = new Set(dataset.map(d => d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '').filter(Boolean));
            const days = dates.size || 1;
            return { rate: (dataset.length / days).toFixed(1), days, total: dataset.length };
        };

        const getDefectStats = (dataset) => {
            const bad = dataset.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
            const pct = dataset.length > 0 ? ((bad / dataset.length) * 100).toFixed(1) : '0.0';
            return { bad, pct, good: dataset.length - bad };
        };

        const getPoleTypes = (dataset) => {
            const counts = {};
            dataset.forEach(d => {
                const t = (d["Type of Pole"] || 'Unknown').toUpperCase();
                counts[t] = (counts[t] || 0) + 1;
            });
            return counts;
        };

        // Show Loading State
        responseEl.innerHTML = '<div class="ai-loading"><span></span><span></span><span></span></div>';
        responseEl.classList.add('visible');

        setTimeout(() => {
            const data = filteredData;
            let answer = "";

            // Extract numeric limit (e.g., "Top 10")
            const numMatch = query.match(/(\d+)/);
            const customLimit = numMatch ? parseInt(numMatch[1]) : 5;

            // --- CONTEXT FILTERING (stacking: vendor > feeder > DT > BU > undertaking) ---
            let contextData = data;
            let contextParts = [];

            // Vendor detection
            const vendors = [...new Set(data.map(d => d.Vendor_Name))].filter(Boolean);
            let foundVendor = null;
            for (let v of vendors) {
                if (query.includes(v.toLowerCase())) { foundVendor = v; break; }
            }
            if (!foundVendor) {
                if (query.includes('ikeja') || query.match(/\bie\b/)) foundVendor = vendors.find(v => v.includes('Ikeja'));
                if (!foundVendor && query.includes('etc')) foundVendor = vendors.find(v => v.includes('ETC'));
                if (!foundVendor && query.includes('jesom')) foundVendor = vendors.find(v => v.includes('Jesom'));
            }
            if (foundVendor) {
                contextData = contextData.filter(d => d.Vendor_Name === foundVendor);
                contextParts.push(foundVendor);
            }

            // Feeder detection
            const allFeeders = [...new Set(data.map(d => d.Feeder).filter(Boolean))];
            let foundFeeder = null;
            for (let f of allFeeders) {
                if (query.includes(f.toLowerCase())) { foundFeeder = f; break; }
            }
            if (!foundFeeder) foundFeeder = findClosestEntity(query, allFeeders);
            // Only apply feeder filter if the query explicitly mentions feeder-related terms or the match is strong
            if (foundFeeder && (query.includes('feeder') || query.includes(foundFeeder.toLowerCase().split('-')[0]))) {
                contextData = contextData.filter(d => d.Feeder === foundFeeder);
                contextParts.push('Feeder: ' + foundFeeder);
            } else { foundFeeder = null; }

            // DT detection
            const allDTs = [...new Set(data.map(d => d["DT Name"]).filter(Boolean))];
            let foundDT = null;
            for (let dt of allDTs) {
                if (query.includes(dt.toLowerCase())) { foundDT = dt; break; }
            }
            if (foundDT) {
                contextData = contextData.filter(d => d["DT Name"] === foundDT);
                contextParts.push('DT: ' + foundDT);
            }

            // Business Unit detection
            const allBUs = [...new Set(data.map(d => d["Bussines Unit"]).filter(Boolean))];
            let foundBU = null;
            if (query.match(/\bbu\b|business unit/)) {
                for (let bu of allBUs) {
                    if (query.includes(bu.toLowerCase())) { foundBU = bu; break; }
                }
                if (!foundBU) foundBU = findClosestEntity(query.replace(/business unit|bu/g, '').trim(), allBUs);
            } else {
                for (let bu of allBUs) {
                    if (query.includes(bu.toLowerCase())) { foundBU = bu; break; }
                }
            }
            if (foundBU) {
                contextData = contextData.filter(d => d["Bussines Unit"] === foundBU);
                contextParts.push('BU: ' + foundBU);
            }

            // Undertaking detection
            const allUTs = [...new Set(data.map(d => d.Undertaking).filter(Boolean))];
            let foundUT = null;
            if (query.includes('undertaking')) {
                for (let ut of allUTs) {
                    if (query.includes(ut.toLowerCase())) { foundUT = ut; break; }
                }
                if (!foundUT) foundUT = findClosestEntity(query.replace(/undertaking/g, '').trim(), allUTs);
            } else {
                for (let ut of allUTs) {
                    if (query.includes(ut.toLowerCase())) { foundUT = ut; break; }
                }
            }
            if (foundUT) {
                contextData = contextData.filter(d => d.Undertaking === foundUT);
                contextParts.push('Undertaking: ' + foundUT);
            }

            const contextName = contextParts.length > 0 ? contextParts.join(' > ') : 'All Data';

            // --- INTENT DETECTION (broader, ordered by specificity) ---
            let intent = "unknown";

            if (query.match(/\bcompare\b|\bvs\b|\bversus\b|difference between/)) intent = "compare";
            else if (query.match(/\bsummary\b|\boverview\b|\bstatus\b|\breport\b|\bdashboard\b|\bbrief\b/)) intent = "summary";
            else if (query.match(/\bboq\b|\btarget\b|\bbill of quantit|\bplanned\b|\bprocurement\b/)) intent = "boq";
            else if (query.match(/\btrend\b|\bover time\b|\bprogress\b|\byesterday\b|\btoday\b|\blast\s+\d+\s+day|\bthis week\b|\bweekly\b|\bwhen\b|\bdate\b|\btimeline\b/)) intent = "trend";
            else if (query.match(/\btop\b|\bbest\b|\bhighest\b|\bmost\b|\blead\b|\bfirst\b/)) intent = "rank_high";
            else if (query.match(/\bbottom\b|\bworst\b|\blowest\b|\bleast\b|\bslowest\b/)) intent = "rank_low";
            else if (query.match(/\brun rate\b|\bvelocity\b|\bspeed\b|\bpace\b|\bavg rate\b|\bdaily rate\b/)) intent = "run_rate";
            else if (query.match(/\bissue\b|\bdefect\b|\bproblem\b|\bbroken\b|\bdamage\b|\bbad\b|\bquality\b/)) intent = "issues";
            else if (query.match(/\bpole type\b|\bmaterial\b|\bconcrete\b|\bwood\b|\bdistribution of pole|\bpole.*breakdown\b/)) intent = "pole_type";
            else if (query.match(/\bbuilding\b|\bconnected\b|\bserved\b|\bcustomer\b/)) intent = "buildings";
            else if (query.match(/\blocation\b|\baddress\b|\barea\b|\bwhere\b|\bregion\b/)) intent = "location";
            else if (query.match(/\bcount\b|\btotal\b|\bhow many\b|\bnumber\b/)) intent = "count";
            else if (query.match(/\bfeeder\b/) && !foundFeeder) intent = "list_feeders";
            else if (query.match(/\bdt\b|\btransformer\b/) && !foundDT) intent = "list_dts";
            else if (query.match(/\bundertaking\b/) && !foundUT) intent = "list_uts";
            else if (query.match(/\bbusiness unit\b|\bbu\b/) && !foundBU) intent = "list_bus";

            // --- INTENT EXECUTION ---

            // RANKING
            if (intent === "rank_high" || intent === "rank_low") {
                const isHigh = intent === "rank_high";
                const sortMult = isHigh ? -1 : 1;
                const adj = isHigh ? "Top" : "Bottom";

                if (query.includes('vendor') && !foundVendor) {
                    const counts = {};
                    contextData.forEach(d => counts[d.Vendor_Name] = (counts[d.Vendor_Name] || 0) + 1);
                    const sorted = Object.entries(counts).sort((a, b) => (a[1] - b[1]) * sortMult);
                    const list = sorted.slice(0, customLimit).map((v, i) => `${i + 1}. **${v[0]}** — ${formatNum(v[1])} poles`).join('<br>');
                    answer = `**${adj} Vendors:**<br>${list}`;
                }
                else if (query.match(/feeder/)) {
                    const counts = {};
                    contextData.forEach(d => { if (d.Feeder) counts[d.Feeder] = (counts[d.Feeder] || 0) + 1; });
                    const sorted = Object.entries(counts).sort((a, b) => (a[1] - b[1]) * sortMult);
                    const list = sorted.slice(0, customLimit).map((f, i) => `${i + 1}. **${f[0]}** — ${formatNum(f[1])} poles`).join('<br>');
                    answer = `**${adj} ${customLimit} Feeders** (${contextName}):<br>${list}`;
                }
                else if (query.match(/dt|transformer/)) {
                    const counts = {};
                    contextData.forEach(d => { if (d["DT Name"]) counts[d["DT Name"]] = (counts[d["DT Name"]] || 0) + 1; });
                    const sorted = Object.entries(counts).sort((a, b) => (a[1] - b[1]) * sortMult);
                    const list = sorted.slice(0, customLimit).map((dt, i) => `${i + 1}. **${dt[0]}** — ${formatNum(dt[1])} poles`).join('<br>');
                    answer = `**${adj} ${customLimit} DTs** (${contextName}):<br>${list}`;
                }
                else if (query.match(/undertaking/)) {
                    const counts = {};
                    contextData.forEach(d => { if (d.Undertaking) counts[d.Undertaking] = (counts[d.Undertaking] || 0) + 1; });
                    const sorted = Object.entries(counts).sort((a, b) => (a[1] - b[1]) * sortMult);
                    const list = sorted.slice(0, customLimit).map((u, i) => `${i + 1}. **${u[0]}** — ${formatNum(u[1])} poles`).join('<br>');
                    answer = `**${adj} ${customLimit} Undertakings** (${contextName}):<br>${list}`;
                }
                else {
                    // Default: rank users/officers
                    const counts = {};
                    contextData.forEach(d => { if (d.User) counts[d.User] = (counts[d.User] || 0) + 1; });
                    const sorted = Object.entries(counts).sort((a, b) => (a[1] - b[1]) * sortMult);
                    const list = sorted.slice(0, customLimit).map((u, i) => `${i + 1}. ${getDisplayName(u[0])} — **${formatNum(u[1])}** poles`).join('<br>');
                    answer = `**${adj} ${customLimit} Field Officers** (${contextName}):<br>${list}`;
                }
            }

            // COMPARE
            else if (intent === "compare") {
                // Detect two vendors or two users
                const mentionedVendors = vendors.filter(v => query.includes(v.toLowerCase()));
                // Also check shortnames
                if (query.includes('etc') && !mentionedVendors.find(v => v.includes('ETC'))) { const v = vendors.find(v => v.includes('ETC')); if (v) mentionedVendors.push(v); }
                if (query.includes('jesom') && !mentionedVendors.find(v => v.includes('Jesom'))) { const v = vendors.find(v => v.includes('Jesom')); if (v) mentionedVendors.push(v); }
                if ((query.includes('ikeja') || query.match(/\bie\b/)) && !mentionedVendors.find(v => v.includes('Ikeja'))) { const v = vendors.find(v => v.includes('Ikeja')); if (v) mentionedVendors.push(v); }

                if (mentionedVendors.length >= 2) {
                    const rows = mentionedVendors.map(v => {
                        const vd = data.filter(d => d.Vendor_Name === v);
                        const rr = getRunRate(vd);
                        const df = getDefectStats(vd);
                        const users = new Set(vd.map(d => d.User)).size;
                        return `**${v}:**<br>  Poles: ${formatNum(vd.length)} | Run Rate: ${rr.rate}/day | Users: ${users} | Defects: ${df.pct}%`;
                    });
                    answer = `**Vendor Comparison:**<br><br>${rows.join('<br><br>')}`;
                } else if (mentionedVendors.length === 0) {
                    // Compare all vendors
                    const rows = vendors.map(v => {
                        const vd = data.filter(d => d.Vendor_Name === v);
                        const rr = getRunRate(vd);
                        const df = getDefectStats(vd);
                        return `**${v}:** ${formatNum(vd.length)} poles | ${rr.rate}/day | Defects: ${df.pct}%`;
                    });
                    answer = `**All Vendors Comparison:**<br>${rows.join('<br>')}`;
                } else {
                    answer = "Please mention two vendors to compare. E.g., 'Compare ETC vs Ikeja Electric'.";
                }
            }

            // SUMMARY
            else if (intent === "summary") {
                const rr = getRunRate(contextData);
                const df = getDefectStats(contextData);
                const users = new Set(contextData.map(d => d.User)).size;
                const feeders = new Set(contextData.map(d => d.Feeder)).size;
                const dts = new Set(contextData.map(d => d["DT Name"])).size;
                const uts = new Set(contextData.map(d => d.Undertaking)).size;
                const poleTypes = getPoleTypes(contextData);
                const typeStr = Object.entries(poleTypes).map(([k, v]) => `${k}: ${formatNum(v)}`).join(', ');

                let boqTotal = 0;
                if (boqData.length) boqTotal = boqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0);
                const completionPct = boqTotal > 0 ? ((contextData.length / boqTotal) * 100).toFixed(1) : 'N/A';

                answer = `**${contextName} — Dashboard Summary:**<br><br>` +
                    `Total Poles: **${formatNum(contextData.length)}**<br>` +
                    `Active Users: **${users}**<br>` +
                    `Run Rate: **${rr.rate} poles/day** (${rr.days} active days)<br>` +
                    `Feeders: **${feeders}** | DTs: **${dts}** | Undertakings: **${uts}**<br>` +
                    `Defect Rate: **${df.pct}%** (${formatNum(df.bad)} defects)<br>` +
                    `Pole Types: ${typeStr}<br>` +
                    (boqTotal > 0 ? `BOQ Target: **${formatNum(boqTotal)}** | Completion: **${completionPct}%**` : '');
            }

            // BOQ
            else if (intent === "boq") {
                if (!boqData.length) {
                    answer = "No BOQ data is currently loaded.";
                } else {
                    const totalTarget = boqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0);
                    const totalBad = boqData.reduce((s, d) => s + (parseInt(d["BAD"]) || 0), 0);
                    const totalGood = boqData.reduce((s, d) => s + (parseInt(d["GOOD"]) || 0), 0);
                    const totalNew = boqData.reduce((s, d) => s + (parseInt(d["NEW POLE"]) || 0), 0);
                    const actual = contextData.length;
                    const completionPct = totalTarget > 0 ? ((actual / totalTarget) * 100).toFixed(1) : '0';

                    if (query.match(/feeder/) && !query.match(/all/)) {
                        // BOQ by feeder — top feeders by target
                        const sorted = [...boqData].sort((a, b) => (parseInt(b["POLES Grand Total"]) || 0) - (parseInt(a["POLES Grand Total"]) || 0));
                        const list = sorted.slice(0, customLimit).map((d, i) =>
                            `${i + 1}. **${d["FEEDER NAME"] || d["DT NAME"]}** — Target: ${d["POLES Grand Total"]}, Good: ${d["GOOD"]}, Bad: ${d["BAD"]}, New: ${d["NEW POLE"]}`
                        ).join('<br>');
                        answer = `**BOQ — Top ${customLimit} by Target:**<br>${list}`;
                    } else {
                        answer = `**BOQ (Bill of Quantities) Overview:**<br><br>` +
                            `Total BOQ Target: **${formatNum(totalTarget)} poles**<br>` +
                            `Good Poles: **${formatNum(totalGood)}** | Bad Poles: **${formatNum(totalBad)}** | New Poles: **${formatNum(totalNew)}**<br>` +
                            `Actual Field Records: **${formatNum(actual)}**<br>` +
                            `Completion Rate: **${completionPct}%**`;
                    }
                }
            }

            // TREND
            else if (intent === "trend") {
                const dateMap = {};
                contextData.forEach(d => {
                    const ds = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '';
                    if (ds) dateMap[ds] = (dateMap[ds] || 0) + 1;
                });
                const sortedDates = Object.entries(dateMap).sort((a, b) => {
                    const da = new Date(a[0]), db = new Date(b[0]);
                    return da - db;
                });

                if (sortedDates.length === 0) {
                    answer = "No date-stamped records found in the current data.";
                } else {
                    // Check for "last N days" or "yesterday"
                    const daysMatch = query.match(/last\s+(\d+)\s+day/);
                    let recentDates = sortedDates;

                    if (daysMatch) {
                        const n = parseInt(daysMatch[1]);
                        recentDates = sortedDates.slice(-n);
                    } else if (query.includes('yesterday')) {
                        recentDates = sortedDates.slice(-2, -1);
                    } else if (query.includes('today')) {
                        recentDates = sortedDates.slice(-1);
                    } else if (query.includes('week')) {
                        recentDates = sortedDates.slice(-7);
                    } else {
                        recentDates = sortedDates.slice(-10);
                    }

                    const totalInRange = recentDates.reduce((s, d) => s + d[1], 0);
                    const avgInRange = (totalInRange / (recentDates.length || 1)).toFixed(1);
                    const list = recentDates.map(([date, count]) => `${date}: **${count}** poles`).join('<br>');

                    answer = `**Activity Timeline** (${contextName}):<br><br>${list}<br><br>` +
                        `Period Total: **${formatNum(totalInRange)}** | Avg: **${avgInRange}/day**`;
                }
            }

            // RUN RATE
            else if (intent === "run_rate") {
                const rr = getRunRate(contextData);
                const perVendor = vendors.map(v => {
                    const vd = contextData.filter(d => d.Vendor_Name === v);
                    if (vd.length === 0) return null;
                    const vr = getRunRate(vd);
                    return `${v}: **${vr.rate}/day**`;
                }).filter(Boolean);

                answer = `**${contextName} — Run Rate:**<br>` +
                    `Overall: **${rr.rate} poles/day** (${formatNum(rr.total)} poles over ${rr.days} days)`;
                if (!foundVendor && perVendor.length > 1) {
                    answer += `<br><br>By Vendor:<br>${perVendor.join('<br>')}`;
                }
            }

            // ISSUES
            else if (intent === "issues") {
                const df = getDefectStats(contextData);
                const issueCounts = {};
                contextData.forEach(d => {
                    if (d.Issue_Type && d.Issue_Type !== 'Good Condition') {
                        issueCounts[d.Issue_Type] = (issueCounts[d.Issue_Type] || 0) + 1;
                    }
                });
                const sorted = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]);
                const breakdown = sorted.slice(0, 10).map(([type, count]) => `${type}: **${count}**`).join('<br>');

                answer = `**${contextName} — Defect Analysis:**<br>` +
                    `Total Defects: **${formatNum(df.bad)}** out of ${formatNum(contextData.length)} (${df.pct}%)<br>`;
                if (breakdown) answer += `<br>Breakdown:<br>${breakdown}`;

                // Top users with defects
                const userDefects = {};
                contextData.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').forEach(d => {
                    userDefects[d.User] = (userDefects[d.User] || 0) + 1;
                });
                const topDefectUsers = Object.entries(userDefects).sort((a, b) => b[1] - a[1]).slice(0, 3);
                if (topDefectUsers.length) {
                    answer += `<br><br>Top Defect Reporters:<br>` +
                        topDefectUsers.map((u, i) => `${i + 1}. ${getDisplayName(u[0])} — ${u[1]} defects`).join('<br>');
                }
            }

            // POLE TYPE
            else if (intent === "pole_type") {
                const types = getPoleTypes(contextData);
                const total = contextData.length;
                const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
                const list = sorted.map(([type, count]) =>
                    `**${type}**: ${formatNum(count)} (${(count / total * 100).toFixed(1)}%)`
                ).join('<br>');
                answer = `**${contextName} — Pole Type Distribution:**<br><br>${list}<br><br>Total: **${formatNum(total)}**`;
            }

            // BUILDINGS
            else if (intent === "buildings") {
                const buildingCounts = contextData.map(d => parseInt(d["No of Buildings Connected to the Pole"]) || 0);
                const totalBuildings = buildingCounts.reduce((s, n) => s + n, 0);
                const avgBuildings = contextData.length > 0 ? (totalBuildings / contextData.length).toFixed(1) : '0';
                const maxBuildings = Math.max(...buildingCounts, 0);
                const polesWithBuildings = buildingCounts.filter(n => n > 0).length;

                answer = `**${contextName} — Buildings Connected:**<br><br>` +
                    `Total Buildings Served: **${formatNum(totalBuildings)}**<br>` +
                    `Poles with Buildings: **${formatNum(polesWithBuildings)}** of ${formatNum(contextData.length)}<br>` +
                    `Avg Buildings/Pole: **${avgBuildings}**<br>` +
                    `Max on Single Pole: **${maxBuildings}**`;
            }

            // LOCATION
            else if (intent === "location") {
                const addrCounts = {};
                contextData.forEach(d => {
                    const addr = d["Location address"];
                    if (addr) {
                        const area = addr.split(',').pop().trim() || addr;
                        addrCounts[area] = (addrCounts[area] || 0) + 1;
                    }
                });
                const sorted = Object.entries(addrCounts).sort((a, b) => b[1] - a[1]);
                const list = sorted.slice(0, customLimit).map((a, i) => `${i + 1}. **${a[0]}** — ${a[1]} poles`).join('<br>');
                answer = `**${contextName} — Top ${customLimit} Areas:**<br><br>${list}`;
            }

            // COUNT
            else if (intent === "count") {
                if (query.match(/dt|transformer/)) {
                    const dts = new Set(contextData.map(d => d["DT Name"])).size;
                    answer = `**${formatNum(dts)} Unique DTs** in ${contextName}.`;
                } else if (query.match(/feed/)) {
                    const feeders = new Set(contextData.map(d => d.Feeder)).size;
                    answer = `**${formatNum(feeders)} Feeders** in ${contextName}.`;
                } else if (query.match(/user|officer|people|staff/)) {
                    const users = new Set(contextData.map(d => d.User)).size;
                    answer = `**${users} Active Field Officers** in ${contextName}.`;
                } else if (query.match(/undertaking/)) {
                    const uts = new Set(contextData.map(d => d.Undertaking)).size;
                    answer = `**${formatNum(uts)} Undertakings** in ${contextName}.`;
                } else if (query.match(/business unit|\bbu\b/)) {
                    const bus = new Set(contextData.map(d => d["Bussines Unit"])).size;
                    answer = `**${formatNum(bus)} Business Units** in ${contextName}.`;
                } else if (query.match(/wood/)) {
                    const n = contextData.filter(d => (d["Type of Pole"] || "").toUpperCase().includes('WOOD')).length;
                    answer = `Wooden Poles in ${contextName}: **${formatNum(n)}**`;
                } else if (query.match(/concrete|conc/)) {
                    const n = contextData.filter(d => (d["Type of Pole"] || "").toUpperCase().includes('CONCRETE')).length;
                    answer = `Concrete Poles in ${contextName}: **${formatNum(n)}**`;
                } else if (query.match(/vendor/)) {
                    const vs = {};
                    contextData.forEach(d => { vs[d.Vendor_Name] = (vs[d.Vendor_Name] || 0) + 1; });
                    const list = Object.entries(vs).map(([v, c]) => `**${v}**: ${formatNum(c)}`).join('<br>');
                    answer = `**Vendor Breakdown** (${contextName}):<br>${list}<br>Total: **${formatNum(contextData.length)}**`;
                } else {
                    answer = `Total Poles in ${contextName}: **${formatNum(contextData.length)}** (from ${formatNum(globalData.length)} total).`;
                }
            }

            // LIST FEEDERS
            else if (intent === "list_feeders") {
                const counts = {};
                contextData.forEach(d => { if (d.Feeder) counts[d.Feeder] = (counts[d.Feeder] || 0) + 1; });
                const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                const list = sorted.slice(0, customLimit).map((f, i) => `${i + 1}. **${f[0]}** — ${formatNum(f[1])} poles`).join('<br>');
                answer = `**Feeders in ${contextName}** (${sorted.length} total, showing top ${Math.min(customLimit, sorted.length)}):<br>${list}`;
            }

            // LIST DTs
            else if (intent === "list_dts") {
                const counts = {};
                contextData.forEach(d => { if (d["DT Name"]) counts[d["DT Name"]] = (counts[d["DT Name"]] || 0) + 1; });
                const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                const list = sorted.slice(0, customLimit).map((dt, i) => `${i + 1}. **${dt[0]}** — ${formatNum(dt[1])} poles`).join('<br>');
                answer = `**DTs in ${contextName}** (${sorted.length} total, showing top ${Math.min(customLimit, sorted.length)}):<br>${list}`;
            }

            // LIST UNDERTAKINGS
            else if (intent === "list_uts") {
                const counts = {};
                contextData.forEach(d => { if (d.Undertaking) counts[d.Undertaking] = (counts[d.Undertaking] || 0) + 1; });
                const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                const list = sorted.slice(0, customLimit).map((u, i) => `${i + 1}. **${u[0]}** — ${formatNum(u[1])} poles`).join('<br>');
                answer = `**Undertakings in ${contextName}** (${sorted.length} total):<br>${list}`;
            }

            // LIST BUSINESS UNITS
            else if (intent === "list_bus") {
                const counts = {};
                contextData.forEach(d => { if (d["Bussines Unit"]) counts[d["Bussines Unit"]] = (counts[d["Bussines Unit"]] || 0) + 1; });
                const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                const list = sorted.slice(0, customLimit).map((b, i) => `${i + 1}. **${b[0]}** — ${formatNum(b[1])} poles`).join('<br>');
                answer = `**Business Units in ${contextName}** (${sorted.length} total):<br>${list}`;
            }

            // FALLBACK — Smart Search
            else {
                // 1. Try user name lookup
                const allUsers = Object.keys(userFullNames).concat(Object.values(userFullNames));
                const closeUser = findClosestEntity(query, allUsers);

                if (closeUser) {
                    let userId = closeUser;
                    if (Object.values(userFullNames).includes(closeUser)) {
                        userId = Object.keys(userFullNames).find(key => userFullNames[key] === closeUser);
                    }
                    const userRecs = data.filter(d => d.User === userId);
                    if (userRecs.length > 0) {
                        const rr = getRunRate(userRecs);
                        const df = getDefectStats(userRecs);
                        const uts = new Set(userRecs.map(d => d.Undertaking)).size;
                        const vendor = userRecs[0].Vendor_Name || 'Unknown';
                        const pTypes = getPoleTypes(userRecs);
                        const typeStr = Object.entries(pTypes).map(([k, v]) => `${k}: ${v}`).join(', ');

                        answer = `**${getDisplayName(userId)}** — Officer Profile:<br><br>` +
                            `Vendor: **${vendor}**<br>` +
                            `Total Poles: **${formatNum(userRecs.length)}**<br>` +
                            `Run Rate: **${rr.rate}/day** (${rr.days} active days)<br>` +
                            `Defect Rate: **${df.pct}%** (${df.bad} defects)<br>` +
                            `Undertakings Covered: **${uts}**<br>` +
                            `Pole Types: ${typeStr}`;
                    } else {
                        answer = `I found user "**${getDisplayName(userId) || closeUser}**" but they have no records in the current view.`;
                    }
                }
                // 2. Try matching a specific feeder name
                else if (findClosestEntity(query, allFeeders)) {
                    const feeder = findClosestEntity(query, allFeeders);
                    const fData = data.filter(d => d.Feeder === feeder);
                    const rr = getRunRate(fData);
                    const df = getDefectStats(fData);
                    const users = new Set(fData.map(d => d.User)).size;
                    const dts = new Set(fData.map(d => d["DT Name"])).size;
                    answer = `**Feeder: ${feeder}**<br><br>` +
                        `Poles: **${formatNum(fData.length)}** | DTs: **${dts}** | Users: **${users}**<br>` +
                        `Run Rate: **${rr.rate}/day** | Defects: **${df.pct}%**`;
                }
                // 3. Try matching a specific DT name
                else if (findClosestEntity(query, allDTs)) {
                    const dt = findClosestEntity(query, allDTs);
                    const dtData = data.filter(d => d["DT Name"] === dt);
                    const rr = getRunRate(dtData);
                    const users = new Set(dtData.map(d => d.User)).size;
                    answer = `**DT: ${dt}**<br><br>` +
                        `Poles: **${formatNum(dtData.length)}** | Users: **${users}** | Run Rate: **${rr.rate}/day**`;
                }
                // 4. Generic text search across all fields
                else {
                    const matches = data.filter(row =>
                        Object.values(row).some(val => val && String(val).toLowerCase().includes(query))
                    );
                    if (matches.length > 0) {
                        const rr = getRunRate(matches);
                        const users = new Set(matches.map(d => d.User)).size;
                        answer = `Found **${formatNum(matches.length)}** records matching "**${rawQuery}**".<br>` +
                            `Users involved: **${users}** | Run Rate: **${rr.rate}/day**`;
                        if (matches.length <= 5) {
                            answer += '<br><br>Records:<br>' + matches.map(m =>
                                `${m["DT Name"] || 'N/A'} — ${m.User ? getDisplayName(m.User) : 'N/A'} — ${m["Date/timestamp"] || ''}`
                            ).join('<br>');
                        }
                    } else {
                        answer = "I couldn't find a match. Try questions like:<br>" +
                            "• **'Summary'** — full dashboard overview<br>" +
                            "• **'Top 10 users'** — best performing officers<br>" +
                            "• **'Compare ETC vs Ikeja'** — vendor comparison<br>" +
                            "• **'BOQ targets'** — bill of quantities<br>" +
                            "• **'Trend last 7 days'** — activity timeline<br>" +
                            "• **'Pole types'** — material distribution<br>" +
                            "• **'Issues in Ikeja Electric'** — defect analysis<br>" +
                            "• Any **user name**, **feeder**, **DT**, or **area name**";
                    }
                }
            }

            // If context was applied, add a context note
            if (contextParts.length > 0 && answer && !answer.startsWith("I couldn't")) {
                answer += `<br><br><small>Context: ${contextName}</small>`;
            }

            // Typewriter Animation
            const typeWriter = (text, element) => {
                element.innerHTML = '';
                element.classList.add('ai-cursor');
                const formattedHtml = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                let index = 0;
                const speed = 12;
                function type() {
                    if (index < formattedHtml.length) {
                        let char = formattedHtml.charAt(index);
                        if (char === '<') {
                            let endTag = formattedHtml.indexOf('>', index);
                            if (endTag !== -1) {
                                element.innerHTML += formattedHtml.substring(index, endTag + 1);
                                index = endTag + 1;
                            } else { element.innerHTML += char; index++; }
                        } else { element.innerHTML += char; index++; }
                        setTimeout(type, speed);
                    } else { element.classList.remove('ai-cursor'); }
                }
                type();
            };

            typeWriter(answer, responseEl);

        }, 1200);
    }

    function updateExecutiveSummary() {
        const container = document.getElementById('exec-dynamic-content');
        if (!container) return;
        const data = filteredData.length > 0 ? filteredData : globalData;
        if (!data || data.length === 0) { container.innerHTML = '<p style="color:var(--text-secondary);">No data available.</p>'; return; }

        const total = data.length;
        const fmt = n => typeof n === 'number' ? n.toLocaleString() : n;

        // Dates & velocity
        const dateStrings = data.map(d => d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '').filter(Boolean);
        const dates = [...new Set(dateStrings)].sort();
        const activeDays = dates.length || 1;
        const runRate = (total / activeDays).toFixed(1);
        const TARGET = 50;

        // Trend
        const recent = dates.slice(-3);
        const prior = dates.slice(-6, -3);
        const recentCount = data.filter(d => recent.includes((d["Date/timestamp"] || '').split(' ')[0])).length;
        const priorCount = data.filter(d => prior.includes((d["Date/timestamp"] || '').split(' ')[0])).length;
        const recentRate = recent.length > 0 ? Math.round(recentCount / recent.length) : 0;
        const priorRate = prior.length > 0 ? Math.round(priorCount / prior.length) : 0;
        const trendPct = priorRate > 0 ? Math.round(((recentRate - priorRate) / priorRate) * 100) : 0;
        const trending = trendPct > 5 ? 'accelerating' : trendPct < -5 ? 'decelerating' : 'holding steady';
        const trendColor = trendPct > 5 ? '#10b981' : trendPct < -5 ? '#ef4444' : '#eab308';

        // Vendors
        const vendorCounts = {};
        data.forEach(d => { vendorCounts[d.Vendor_Name || 'Other'] = (vendorCounts[d.Vendor_Name || 'Other'] || 0) + 1; });
        const sortedVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);
        const vColors = { 'ETC Workforce': '#0EA5E9', 'Jesom Technology': '#f97316', 'Ikeja Electric': '#eab308' };

        // Officers
        const userCounts = {};
        data.forEach(d => { if (d.User) userCounts[d.User] = (userCounts[d.User] || 0) + 1; });
        const totalUsers = Object.keys(userCounts).length;
        const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
        const topOfficer = sortedUsers[0];

        // Coverage
        const feederCount = new Set(data.map(d => d.Feeder).filter(Boolean)).size;
        const dtCount = new Set(data.map(d => d["DT Name"]).filter(Boolean)).size;
        const utCount = new Set(data.map(d => d.Undertaking).filter(Boolean)).size;
        const buCount = new Set(data.map(d => d["Bussines Unit"]).filter(Boolean)).size;

        // Defects
        const defects = data.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
        const defectPct = ((defects / total) * 100).toFixed(1);
        const healthColor = parseFloat(defectPct) > 25 ? '#ef4444' : parseFloat(defectPct) > 15 ? '#eab308' : '#10b981';

        // BOQ
        let activeBoqData = boqData;
        const feederVals = multiSelects.feederFilter?.getValues();
        if (feederVals && feederVals.length > 0) {
            activeBoqData = activeBoqData.filter(d => feederVals.includes(d["FEEDER NAME"]));
        }

        const dtVals = multiSelects.dtFilter?.getValues();
        if (dtVals && dtVals.length > 0) {
            activeBoqData = activeBoqData.filter(d => dtVals.includes(d["DT NAME"]));
        }

        const boqTotal = activeBoqData.length > 0 ? activeBoqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0) : 0;
        const completionPct = boqTotal > 0 ? Math.min(((total / boqTotal) * 100), 100).toFixed(1) : null;

        // Pole types
        const poleTypes = {};
        data.forEach(d => { const t = (d["Type of Pole"] || 'Unknown').toUpperCase(); poleTypes[t] = (poleTypes[t] || 0) + 1; });
        const dominantPole = Object.entries(poleTypes).sort((a, b) => b[1] - a[1])[0];
        const dominantPolePct = dominantPole ? ((dominantPole[1] / total) * 100).toFixed(0) : 0;

        // Date range
        const firstDate = dates[0] || 'N/A';
        const lastDate = dates[dates.length - 1] || 'N/A';

        // Velocity verdict
        let velocityVerdict, velocityColor;
        if (runRate >= TARGET) { velocityVerdict = 'on target'; velocityColor = '#10b981'; }
        else if (runRate >= TARGET * 0.7) { velocityVerdict = 'approaching target'; velocityColor = '#eab308'; }
        else { velocityVerdict = 'below target'; velocityColor = '#ef4444'; }

        // Vendor race mini bars
        const vendorBars = sortedVendors.map(([name, count]) => {
            const pct = ((count / total) * 100).toFixed(0);
            const color = vColors[name] || '#6b7280';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="font-size:0.8rem;min-width:110px;color:${color};font-weight:600;">${name}</span>
                <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;"></div>
                </div>
                <span style="font-size:0.78rem;color:var(--text-secondary);min-width:65px;text-align:right;">${fmt(count)} (${pct}%)</span>
            </div>`;
        }).join('');

        container.innerHTML = `
            <!-- Narrative -->
            <p style="line-height:1.7;margin-bottom:12px;">
                Across <strong>${buCount} Business Unit${buCount > 1 ? 's' : ''}</strong>,
                <strong style="color:hsl(var(--primary));">${fmt(total)} assets</strong> have been captured
                by <strong>${totalUsers} field officers</strong> over ${activeDays} active days
                (${firstDate} — ${lastDate}).
                The project is running at <strong style="color:${velocityColor};">${runRate} poles/day</strong>
                — <strong style="color:${velocityColor};">${velocityVerdict}</strong> (target: ${TARGET}/day)
                and <strong style="color:${trendColor};">${trending}</strong>
                ${Math.abs(trendPct) > 0 ? `(${trendPct > 0 ? '+' : ''}${trendPct}%)` : ''} over recent days.
            </p>

            ${completionPct !== null ? `
            <!-- BOQ Progress -->
            <div style="margin-bottom:14px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <span style="font-size:0.85rem;font-weight:600;color:var(--text-secondary);">BOQ Progress</span>
                    <span style="font-size:0.95rem;font-weight:700;color:${parseFloat(completionPct) >= 50 ? '#10b981' : '#eab308'};">${completionPct}%</span>
                </div>
                <div style="height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">
                    <div style="height:100%;width:${completionPct}%;background:${parseFloat(completionPct) >= 50 ? '#10b981' : '#eab308'};border-radius:4px;transition:width 0.5s;"></div>
                </div>
                <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:3px;">${fmt(total)} of ${fmt(boqTotal)} target poles</div>
            </div>
            ` : ''}

            <!-- Vendor Race -->
            <div style="margin-bottom:14px;">
                <span style="font-size:0.85rem;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:6px;">Vendor Contribution</span>
                ${vendorBars}
            </div>

            <!-- Key Facts Row -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
                <span style="background:rgba(14,165,233,0.1);padding:5px 12px;border-radius:6px;color:#0EA5E9;font-size:0.85rem;font-weight:600;">⚡ ${fmt(total)} Poles</span>
                <span style="background:rgba(249,115,22,0.1);padding:5px 12px;border-radius:6px;color:#f97316;font-size:0.85rem;font-weight:600;">🏙️ ${dtCount} DTs</span>
                <span style="background:rgba(16,185,129,0.1);padding:5px 12px;border-radius:6px;color:#10b981;font-size:0.85rem;font-weight:600;">🔌 ${feederCount} Feeders</span>
                <span style="background:rgba(234,179,8,0.1);padding:5px 12px;border-radius:6px;color:#eab308;font-size:0.85rem;font-weight:600;">📍 ${utCount} Undertakings</span>
            </div>

            <!-- Insights Row -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem;">
                <div style="background:rgba(255,255,255,0.02);padding:8px 10px;border-radius:6px;border-left:3px solid ${healthColor};">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Asset Health</div>
                    <div style="font-weight:700;color:${healthColor};">${(100 - parseFloat(defectPct)).toFixed(1)}% Good <span style="font-weight:400;color:var(--text-secondary);">/ ${defectPct}% defects</span></div>
                </div>
                <div style="background:rgba(255,255,255,0.02);padding:8px 10px;border-radius:6px;border-left:3px solid hsl(var(--primary));">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Top Officer</div>
                    <div style="font-weight:700;color:hsl(var(--foreground));">${topOfficer ? getDisplayName(topOfficer[0]) : 'N/A'} <span style="font-weight:400;color:var(--text-secondary);">(${topOfficer ? fmt(topOfficer[1]) : 0} poles)</span></div>
                </div>
                <div style="background:rgba(255,255,255,0.02);padding:8px 10px;border-radius:6px;border-left:3px solid #eab308;">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Dominant Material</div>
                    <div style="font-weight:700;color:hsl(var(--foreground));">${dominantPole ? dominantPole[0].charAt(0) + dominantPole[0].slice(1).toLowerCase() : 'N/A'} <span style="font-weight:400;color:var(--text-secondary);">(${dominantPolePct}%)</span></div>
                </div>
                <div style="background:rgba(255,255,255,0.02);padding:8px 10px;border-radius:6px;border-left:3px solid #f97316;">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Avg per Officer</div>
                    <div style="font-weight:700;color:hsl(var(--foreground));">${totalUsers > 0 ? Math.round(total / totalUsers) : 0} poles <span style="font-weight:400;color:var(--text-secondary);">/ ${totalUsers} officers</span></div>
                </div>
            </div>
        `;
    }

    function populateFilters() {
        const vendorSelect = document.getElementById('vendorFilter');

        // Populate Vendor Filter (Fixed list based on global data)
        vendorSelect.innerHTML = '<option value="All">All Vendors</option>';
        const vendorsSet = new Set(globalData.map(item => item["Vendor_Name"]));
        vendorsSet.add('Ikeja Electric'); // Manually append to ensure it is part of the filter list
        const vendors = [...vendorsSet].filter(Boolean).sort();
        vendors.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            opt.textContent = item;
            vendorSelect.appendChild(opt);
        });

        // Populate other filters based on global data initially
        populateDependentFilters(globalData);

        // Refresh all multi-select widgets after populating options
        refreshAllMultiSelects();
    }

    function populateDependentFilters(data) {
        const buSelect = document.getElementById('buFilter');
        const utSelect = document.getElementById('utFilter');
        const userSelect = document.getElementById('userFilter');
        const dtSelect = document.getElementById('dtFilter');
        const upriserSelect = document.getElementById('upriserFilter');
        const feederSelect = document.getElementById('feederFilter');
        const dateSelect = document.getElementById('dateFilter');
        // Material is static usually but let's dynamic it if needed, or just keep it static?
        // The original logic checked material in globalData. Let's strictly follow "what I have selected on any vendor"
        const materialSelect = document.getElementById('materialFilter');

        // Helper to preserve selection if possible, else reset
        const saveSelection = (select) => select.value;
        const restoreSelection = (select, oldVal) => {
            if ([...select.options].some(o => o.value === oldVal)) {
                select.value = oldVal;
            } else {
                select.value = 'All'; // Or empty string for some
            }
        };

        // Note: We normally want to reset to 'All' when vendor changes, as requested.
        // But if this is called during init, current values are 'All'.
        // If called during Vendor change, we explicitly want to update options. 
        // We will just clear and populate.

        buSelect.innerHTML = '<option value="All">All Business Units</option>';
        utSelect.innerHTML = '<option value="All">All Undertakings</option>';
        userSelect.innerHTML = '<option value="All">All Users</option>';
        dtSelect.innerHTML = '<option value="All">All DTs</option>';
        upriserSelect.innerHTML = '<option value="All">All Uprisers</option>';
        feederSelect.innerHTML = '<option value="All">All Feeders</option>';
        dateSelect.innerHTML = '<option value="All">All Dates</option>';

        // Dynamically populate Pole Material filter from actual data
        materialSelect.innerHTML = '<option value="">All Materials</option>';
        const materials = [...new Set(data.map(item => (item["Type of Pole"] || '').trim().toUpperCase()).filter(Boolean))].sort();
        materials.forEach(mat => {
            const opt = document.createElement('option');
            opt.value = mat;
            opt.textContent = mat.charAt(0) + mat.slice(1).toLowerCase();
            materialSelect.appendChild(opt);
        });

        // Get unique values from the PROVIDED data
        const bus = [...new Set(data.map(item => item["Bussines Unit"]))].filter(Boolean).sort();
        const uts = [...new Set(data.map(item => item["Undertaking"]))].filter(Boolean).sort();

        const userSet = new Set(data.map(item => item["User"]));
        const vendorVals = multiSelects.vendorFilter?.getValues();
        if (!vendorVals || vendorVals.includes('Ikeja Electric')) {
            // Add Ikeja Electric system usernames to the user filter
            [
                'kadebayo', 'ttope', 'rakinloye', 'vifeanyi', 'osunday', 'wadegoke', 'omoses',
                'doluwaseun', 'dowoicho', 'uifeanyichukwu', 'dekpe', 'odtaiwo', 'iakintola',
                'rabayomi', 'ojohn', 'roluwasoji', 'eikechukwu', 'gakhimien', 'smadu', 'makpan',
                'msanuolu', 'mdaniel', 'molaiya', 'mmichael', 'mwasiu', 'myusuf', 'mola', 'mnnadi',
                'makinmayowa', 'molabode', 'mmatthew', 'mdemilade', 'lkugbayi', 'kerinle',
                'tsolomon', 'aalaba', 'pralph', 'tadegolu', 'bayodele', 'fjohnson', 'atemidayo',
                'osamuel', 'sabdulmuiz', 'eobasi', 'oadeagbo', 'ajmustapha', 'dobademi',
                'aluqman', 'ustephen', 'jutibe', 'oolawaiye', 'aadeola', 'cfonatius', 'bbankole',
                'gabefe', 'madedayo', 'smartins', 'aabbul', 'sthompson', 'aomotoyo', 'aquadri',
                'ajulius', 'dgabriel', 'cogochukwu', 'majao', 'cejindu', 'oedobor', 'ooladapo',
                'dolujide', 'eodiana', 'jmark', 'aezekiel', 'ponwubiko'
            ].forEach(n => userSet.add(n));
        }

        // Build set of usernames that actually have data records in this dataset
        const usersWithData = new Set(data.map(item => item['User']).filter(Boolean));

        // Map all raw ids to their resolved display names, then deduplicate.
        // For each unique display name we keep ONE entry — preferring the id that has
        // actual data records (so the filter works when the user selects a name).
        const seenDisplayNames = new Map(); // displayName → best {id, name, hasData}

        [...userSet].filter(Boolean).forEach(username => {
            const displayName = getDisplayName(username);
            if (!displayName) return;

            const hasData = usersWithData.has(username);
            const existing = seenDisplayNames.get(displayName);

            if (!existing) {
                seenDisplayNames.set(displayName, { id: username, name: displayName, hasData });
            } else if (!existing.hasData && hasData) {
                // Prefer the entry that actually has records in the dataset
                seenDisplayNames.set(displayName, { id: username, name: displayName, hasData });
            }
        });

        const users = [...seenDisplayNames.values()]
            .sort((a, b) => a.name.localeCompare(b.name));

        const dts = [...new Set(data.map(item => item["DT Name"]))].filter(Boolean).sort();
        const uprisers = [...new Set(data.map(item => item["UpriserNo"]))].filter(Boolean).sort((a, b) => a - b);
        const feeders = [...new Set(data.map(item => item["Feeder"]))].filter(Boolean).sort();
        const dates = [...new Set(data.map(item => item["Date/timestamp"] ? item["Date/timestamp"].split(' ')[0] : ''))].filter(Boolean).sort((a, b) => new Date(b) - new Date(a));

        const populateSelect = (select, items) => {
            items.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item;
                opt.textContent = item;
                select.appendChild(opt);
            });
        };

        populateSelect(buSelect, bus);
        populateSelect(utSelect, uts);

        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.name;
            userSelect.appendChild(opt);
        });

        populateSelect(dtSelect, dts);
        populateSelect(upriserSelect, uprisers);
        populateSelect(feederSelect, feeders);
        populateSelect(dateSelect, dates);
    }

    function handleVendorChange() {
        const vendorVals = multiSelects.vendorFilter.getValues();
        let relevantData = globalData;
        if (vendorVals) {
            relevantData = globalData.filter(item => vendorVals.includes(item["Vendor_Name"]));
        }

        // Reset dependent filters and update their options
        ['buFilter', 'utFilter', 'userFilter', 'feederFilter', 'dtFilter', 'upriserFilter', 'materialFilter', 'dateFilter'].forEach(id => {
            if (multiSelects[id]) multiSelects[id].selectedValues.clear();
        });

        populateDependentFilters(relevantData);

        // Refresh dependent multi-selects
        ['buFilter', 'utFilter', 'userFilter', 'feederFilter', 'dtFilter', 'upriserFilter', 'materialFilter', 'dateFilter'].forEach(id => {
            if (multiSelects[id]) multiSelects[id].refresh();
        });

        applyFilters();
    }

    function updateDTOptions() {
        const feederVals = multiSelects.feederFilter.getValues();
        const dtSelect = document.getElementById('dtFilter');

        // Respect Vendor Context
        const vendorVals = multiSelects.vendorFilter.getValues();
        let contextData = globalData;
        if (vendorVals) {
            contextData = globalData.filter(item => vendorVals.includes(item["Vendor_Name"]));
        }

        // Get relevant data based on Feeder selection within Vendor Context
        let relevantData = contextData;
        if (feederVals) {
            relevantData = contextData.filter(item => feederVals.includes(item["Feeder"]));
        }

        // Get unique DTs
        const dts = [...new Set(relevantData.map(item => item["DT Name"]))].filter(Boolean).sort();

        // Clear and populate the underlying select
        dtSelect.innerHTML = '<option value="All">All DTs</option>';
        dts.forEach(dt => {
            const opt = document.createElement('option');
            opt.value = dt;
            opt.textContent = dt;
            dtSelect.appendChild(opt);
        });

        // Remove stale DT selections and refresh widget
        if (multiSelects.dtFilter) {
            const dtSet = new Set(dts);
            multiSelects.dtFilter.selectedValues = new Set(
                [...multiSelects.dtFilter.selectedValues].filter(v => dtSet.has(v))
            );
            multiSelects.dtFilter.refresh();
        }

        // Trigger Upriser update
        updateUpriserOptions();
    }

    function updateUpriserOptions() {
        const dtVals = multiSelects.dtFilter.getValues();
        const feederVals = multiSelects.feederFilter.getValues();
        const upriserSelect = document.getElementById('upriserFilter');

        // Respect Vendor Context
        const vendorVals = multiSelects.vendorFilter.getValues();
        let contextData = globalData;
        if (vendorVals) {
            contextData = globalData.filter(item => vendorVals.includes(item["Vendor_Name"]));
        }

        // Get relevant data based on DT (and implicitly Feeder)
        let relevantData = contextData;
        if (dtVals) {
            relevantData = contextData.filter(item => dtVals.includes(item["DT Name"]));
        } else if (feederVals) {
            relevantData = contextData.filter(item => feederVals.includes(item["Feeder"]));
        }

        // Get unique Uprisers
        const uprisers = [...new Set(relevantData.map(item => item["UpriserNo"]))].filter(Boolean).sort((a, b) => a - b);

        // Clear and populate
        upriserSelect.innerHTML = '<option value="All">All Uprisers</option>';
        uprisers.forEach(upriser => {
            const opt = document.createElement('option');
            opt.value = upriser;
            opt.textContent = upriser;
            upriserSelect.appendChild(opt);
        });

        // Remove stale selections and refresh widget
        if (multiSelects.upriserFilter) {
            const upSet = new Set(uprisers.map(String));
            multiSelects.upriserFilter.selectedValues = new Set(
                [...multiSelects.upriserFilter.selectedValues].filter(v => upSet.has(v))
            );
            multiSelects.upriserFilter.refresh();
        }
    }

    function applyFilters() {
        const vendorVals = multiSelects.vendorFilter?.getValues();
        const buVals = multiSelects.buFilter?.getValues();
        const utVals = multiSelects.utFilter?.getValues();
        const userVals = multiSelects.userFilter?.getValues();
        const dtVals = multiSelects.dtFilter?.getValues();
        const upriserVals = multiSelects.upriserFilter?.getValues();
        const feederVals = multiSelects.feederFilter?.getValues();
        const matVals = multiSelects.materialFilter?.getValues();
        const dateVals = multiSelects.dateFilter?.getValues();

        filteredData = globalData.filter(item => {
            const poleType = (item["Type of Pole"] || '').trim().toUpperCase();

            return (!vendorVals || vendorVals.includes(item["Vendor_Name"])) &&
                (!buVals || buVals.includes(item["Bussines Unit"])) &&
                (!utVals || utVals.includes(item["Undertaking"])) &&
                (!userVals || userVals.includes(item["User"])) &&
                (!dtVals || dtVals.includes(item["DT Name"])) &&
                (!upriserVals || upriserVals.includes(String(item["UpriserNo"]))) &&
                (!feederVals || feederVals.includes(item["Feeder"])) &&
                (!matVals || matVals.includes(poleType)) &&
                (!dateVals || (item["Date/timestamp"] && dateVals.some(d => item["Date/timestamp"].startsWith(d))));
        });

        updateDashboard();
    }

    function updateDashboard() {
        const fieldCharts = document.getElementById('charts');
        const varianceCharts = document.getElementById('variance-charts');

        if (viewMode === 'boq') {
            // Show Variance View
            if (fieldCharts) fieldCharts.classList.add('hidden');
            if (varianceCharts) varianceCharts.classList.remove('hidden');
            updateKPIs(); // Will handle variance logic
            renderVarianceCharts();
            renderDTTable(); // Will handle variance columns
        } else {
            // Show Field View
            if (fieldCharts) fieldCharts.classList.remove('hidden');
            if (varianceCharts) varianceCharts.classList.add('hidden');
            updateKPIs();
            renderUserPerformanceChart();
            renderProjectVelocityChart();
            renderPoleTypeChart();
            renderStaffIssuesChart();
            renderUndertakingChart();
            renderFeederChart();
            renderVendorPerformanceCharts();
            renderDTTable();
        }
        // Map is shared or hidden? User didn't specify. Left as is (always showing map based on field data).
        // Maybe hide map in variance mode? User said "View Mode: Field Captures Only | BOQ vs. Actual".
        // Usually map is useful. Detailed request didn't say hide map.
        renderMap();
        updateKeyInsights();
        renderStrategicRecommendations();
        updateExecutiveSummary();
    }


    function updateKPIs() {
        // Helper to formatting numbers
        const fmt = n => n ? n.toLocaleString() : '0';

        // Filter BOQ Data based on active Feeder and DT Name
        let activeBoqData = boqData;
        const feederVals = multiSelects.feederFilter?.getValues();
        if (feederVals && feederVals.length > 0) {
            activeBoqData = activeBoqData.filter(d => feederVals.includes(d["FEEDER NAME"]));
        }

        const dtVals = multiSelects.dtFilter?.getValues();
        if (dtVals && dtVals.length > 0) {
            activeBoqData = activeBoqData.filter(d => dtVals.includes(d["DT NAME"]));
        }

        // Update Top Cards
        const topActiveEl = document.getElementById('topCardActiveUsers');
        if (topActiveEl) {
            const activeUsersCount = new Set(filteredData.map(d => d.User).filter(Boolean)).size;
            topActiveEl.textContent = activeUsersCount.toLocaleString();
        }

        // Split Project Completion Rate: Incl. New Poles and Excl. New Poles
        const topCompRateEl = document.getElementById('topCardCompletionRate');
        const topCompBarEl = document.getElementById('topCardCompletionBar');
        const topCompRateExNewEl = document.getElementById('topCardCompletionRateExNew');
        const topCompBarExNewEl = document.getElementById('topCardCompletionBarExNew');

        const totalBoqAllTop = activeBoqData.reduce((sum, d) => sum + (parseInt(d["POLES Grand Total"]) || 0), 0);
        const totalBoqNewTop = activeBoqData.reduce((sum, d) => sum + (parseInt(d["NEW POLE"]) || 0), 0);
        const totalBoqExNewTop = Math.max(0, totalBoqAllTop - totalBoqNewTop);
        const actRecordsAllTop = filteredData.length;
        const actNewCountTop = filteredData.filter(d =>
            (d.Pole_Type && d.Pole_Type.toLowerCase().includes('new')) ||
            (d.Issue_Type && d.Issue_Type.toLowerCase().includes('new'))
        ).length;
        const actRecordsExNewTop = Math.max(0, actRecordsAllTop - actNewCountTop);

        // Incl. New Poles (Total Poles card base)
        if (topCompRateEl && topCompBarEl) {
            let rateIncl = totalBoqAllTop > 0 ? (actRecordsAllTop / totalBoqAllTop) * 100 : 0;
            if (rateIncl > 100) rateIncl = 100;
            topCompRateEl.textContent = rateIncl.toFixed(1) + '%';
            topCompBarEl.style.width = rateIncl + '%';
        }

        // Excl. New Poles (Total Poles Ex. New card base)
        if (topCompRateExNewEl && topCompBarExNewEl) {
            let rateExcl = totalBoqExNewTop > 0 ? (actRecordsExNewTop / totalBoqExNewTop) * 100 : 0;
            if (rateExcl > 100) rateExcl = 100;
            topCompRateExNewEl.textContent = rateExcl.toFixed(1) + '%';
            topCompBarExNewEl.style.width = rateExcl + '%';
        }

        // 1. Calculate Metrics

        // --- A. Records (Poles) — unique by SLRN ---
        const boqRecords = activeBoqData.reduce((sum, d) => sum + (parseInt(d["POLES Grand Total"]) || 0), 0);
        const uniquePoleSLRNs = new Set();
        filteredData.forEach(item => {
            const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
            if (slrn) uniquePoleSLRNs.add(slrn);
        });
        const actRecords = uniquePoleSLRNs.size;
        updateModernCard('records', boqRecords, actRecords);

        // --- D. New Poles (Install) — unique by SLRN --- (calculated early so Ex. New card can subtract it)
        const boqNew = activeBoqData.reduce((sum, d) => sum + (parseInt(d["NEW POLE"]) || 0), 0);
        const newPoleSLRNs = new Set();
        filteredData.forEach(item => {
            const isNew = (item.Pole_Type && item.Pole_Type.toLowerCase().includes('new')) ||
                          (item.Issue_Type && item.Issue_Type.toLowerCase().includes('new'));
            if (isNew) {
                const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
                if (slrn) newPoleSLRNs.add(slrn);
            }
        });
        const actNew = newPoleSLRNs.size;

        // --- A2. Total Poles excluding New Poles ---
        const boqRecordsExNew = Math.max(0, boqRecords - boqNew);
        const actRecordsExNew = Math.max(0, actRecords - actNew);
        updateModernCard('records-exnew', boqRecordsExNew, actRecordsExNew);

        // --- B. Good Poles (Concrete/Good) — unique by SLRN ---
        const boqGood = activeBoqData.reduce((sum, d) => sum + (parseInt(d["GOOD"]) || 0), 0);
        const goodPoleSLRNs = new Set();
        filteredData.forEach(item => {
            if (item.Issue_Type === 'Good Condition') {
                const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
                if (slrn) goodPoleSLRNs.add(slrn);
            }
        });
        const actGood = goodPoleSLRNs.size;
        updateModernCard('concrete', boqGood, actGood);

        // --- C. Bad Poles (Wooden/Replace) — unique by SLRN ---
        const boqBad = activeBoqData.reduce((sum, d) => sum + (parseInt(d["BAD"]) || 0), 0);
        const badPoleSLRNs = new Set();
        filteredData.forEach(item => {
            if (item.Issue_Type !== 'Good Condition') {
                const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
                if (slrn) badPoleSLRNs.add(slrn);
            }
        });
        const actBad = badPoleSLRNs.size;
        updateModernCard('wooden', boqBad, actBad);

        updateModernCard('users', boqNew, actNew);

        // --- E. Feeders ---
        const boqFeeders = new Set(activeBoqData.map(d => d["FEEDER NAME"])).size;
        const actFeeders = new Set(filteredData.map(d => d.Feeder)).size;
        updateModernCard('feeders', boqFeeders, actFeeders);

        // --- F. DTs ---
        const boqDTs = new Set(activeBoqData.map(d => d["DT NAME"])).size;
        const actDTs = new Set(filteredData.map(d => d["DT Name"] || d["DT_Name"])).size;
        updateModernCard('dts', boqDTs, actDTs);

        // --- G. Buildings (unique by SLRN) ---
        const boqBuildings = 0;
        const uniqueBuildingSLRNs = new Set();
        filteredData.forEach(item => {
            const slrnField = item["Associated Buildings SLRN"] || "";
            slrnField.split(";").forEach(s => {
                const trimmed = s.trim();
                if (trimmed) uniqueBuildingSLRNs.add(trimmed);
            });
        });
        const actBuildings = uniqueBuildingSLRNs.size;
        updateModernCard('buildings', boqBuildings, actBuildings);
    }

    function updateModernCard(suffix, boqVal, actVal) {
        const elBoq = document.getElementById(`kpi-boq-${suffix}`);
        const elAct = document.getElementById(`kpi-act-${suffix}`);
        const elProg = document.getElementById(`kpi-prog-${suffix}`);
        const elBar = document.getElementById(`kpi-bar-${suffix}`);
        const elRem = document.getElementById(`kpi-rem-${suffix}`);

        if (!elAct) return;

        // Set Values
        if (elBoq) elBoq.textContent = (boqVal > 0 || boqData.length > 0) ? boqVal.toLocaleString() : '-';
        elAct.textContent = actVal.toLocaleString();

        // Calculate Progress
        let pct = 0;
        if (boqVal > 0) {
            pct = (actVal / boqVal) * 100;
        }

        const displayPct = pct.toFixed(1) + '%';
        const barWidth = Math.min(pct, 100) + '%';

        if (elProg) elProg.textContent = displayPct;
        if (elBar) elBar.style.width = barWidth;

        // Remaining
        if (elRem) {
            if (boqVal > 0 || boqData.length > 0) {
                const rem = boqVal - actVal;
                elRem.textContent = `Remaining: ${Math.max(0, rem).toLocaleString()}`;
            } else {
                elRem.textContent = 'Remaining: -';
            }
        }
    }

    // --- Chart Rendering Functions ---

    // 1. User Performance (Bar Chart)
    function renderUserPerformanceChart() {
        const userCounts = {};
        const userVendors = {};

        filteredData.forEach(d => {
            userCounts[d.User] = (userCounts[d.User] || 0) + 1;
            if (!userVendors[d.User]) userVendors[d.User] = d.Vendor_Name;
        });

        const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
        const xUsernames = sortedUsers.map(u => u[0]);
        // Map usernames to full names, fallback to username if not found
        const xLabels = xUsernames.map(u => getDisplayName(u));
        const y = sortedUsers.map(u => u[1]);

        // Assign colors based on vendor
        const colors = xUsernames.map(user => {
            const vendor = userVendors[user];
            if (vendor === 'ETC Workforce') return '#0EA5E9'; // Blue
            if (vendor === 'Jesom Technology') return '#f97316'; // Orange
            return '#a0a0a0'; // Grey for others
        });

        const trace = {
            x: xLabels, // Use full names here
            y: y,
            type: 'bar',
            marker: {
                color: colors
            }
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#fafafa' },
            margin: { t: 50, b: 120, l: 50, r: 20 },
            xaxis: { title: '', tickangle: -45 },
            yaxis: { title: 'Records Captured' },
            annotations: [
                {
                    xref: 'paper', yref: 'paper',
                    x: 0.5, y: 1.12,
                    xanchor: 'center', yanchor: 'bottom',
                    text: '<span style="color:#0EA5E9">■</span> ETC Workforce  <span style="color:#f97316">■</span> Jesom Technology  <span style="color:#eab308">■</span> Ikeja Electric',
                    showarrow: false,
                    font: { size: 12, color: '#fafafa' }
                }
            ]
        };

        Plotly.newPlot('userPerformanceChart', [trace], layout, { responsive: true });
    }

    // 2. Project Velocity (Area Chart Comparison)
    function renderProjectVelocityChart() {
        const dateVendorCounts = {};

        filteredData.forEach(d => {
            const raw = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '';
            if (!raw) return;
            const vendor = d.Vendor_Name;
            if (!dateVendorCounts[raw]) {
                dateVendorCounts[raw] = { 'ETC Workforce': 0, 'Jesom Technology': 0, 'Ikeja Electric': 0 };
            }
            if (dateVendorCounts[raw][vendor] !== undefined) dateVendorCounts[raw][vendor]++;
        });

        // Parse and sort dates properly
        const parseDateStr = (s) => {
            // Format is mm/dd/yyyy (e.g. 01/30/2026 = Jan 30)
            const parts = s.split('/');
            if (parts.length === 3) {
                return new Date(parts[2], parts[0] - 1, parts[1]);
            }
            return new Date(s);
        };

        const sortedRaw = Object.keys(dateVendorCounts).sort((a, b) => parseDateStr(a) - parseDateStr(b));

        // Format dates as readable labels
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const dateLabels = sortedRaw.map(s => {
            const d = parseDateStr(s);
            return `${months[d.getMonth()]} ${d.getDate()}`;
        });

        const yETC = sortedRaw.map(d => dateVendorCounts[d]['ETC Workforce']);
        const yJesom = sortedRaw.map(d => dateVendorCounts[d]['Jesom Technology']);
        const yIkeja = sortedRaw.map(d => dateVendorCounts[d]['Ikeja Electric']);

        // Stacked bar chart — each vendor's daily contribution is clearly visible
        const traceETC = {
            x: dateLabels, y: yETC, name: 'ETC Workforce', type: 'bar',
            marker: { color: '#0EA5E9' },
            hovertemplate: 'ETC: %{y} poles<extra></extra>'
        };
        const traceJesom = {
            x: dateLabels, y: yJesom, name: 'Jesom Technology', type: 'bar',
            marker: { color: '#f97316' },
            hovertemplate: 'Jesom: %{y} poles<extra></extra>'
        };
        const traceIkeja = {
            x: dateLabels, y: yIkeja, name: 'Ikeja Electric', type: 'bar',
            marker: { color: '#eab308' },
            hovertemplate: 'Ikeja: %{y} poles<extra></extra>'
        };

        // Cumulative total line overlay
        let cumulative = 0;
        const yCumulative = sortedRaw.map(d => {
            cumulative += dateVendorCounts[d]['ETC Workforce'] + dateVendorCounts[d]['Jesom Technology'] + dateVendorCounts[d]['Ikeja Electric'];
            return cumulative;
        });
        const traceCumulative = {
            x: dateLabels, y: yCumulative, name: 'Cumulative Total', type: 'scatter',
            mode: 'lines+markers',
            line: { color: '#10b981', width: 2, dash: 'dot' },
            marker: { size: 4, color: '#10b981' },
            yaxis: 'y2',
            hovertemplate: 'Total: %{y} poles<extra></extra>'
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(255,255,255,0.02)',
            font: { color: '#e4e5e7', size: 11 },
            barmode: 'stack',
            xaxis: {
                title: '',
                tickangle: sortedRaw.length > 15 ? -45 : 0,
                tickfont: { size: 10 },
                gridcolor: 'rgba(255,255,255,0.05)'
            },
            yaxis: {
                title: 'Daily Poles',
                titlefont: { size: 11 },
                gridcolor: 'rgba(255,255,255,0.06)'
            },
            yaxis2: {
                title: 'Cumulative',
                titlefont: { size: 11, color: '#10b981' },
                tickfont: { color: '#10b981' },
                overlaying: 'y',
                side: 'right',
                showgrid: false
            },
            margin: { t: 20, l: 50, r: 55, b: sortedRaw.length > 15 ? 90 : 50 },
            showlegend: true,
            legend: { orientation: 'h', y: -0.35, x: 0.5, xanchor: 'center', font: { size: 11 } },
            bargap: 0.15
        };

        Plotly.newPlot('projectVelocityChart', [traceETC, traceJesom, traceIkeja, traceCumulative], layout, { responsive: true });
    }

    // 3. Pole Type Distribution (highcharts 3D Pie Chart)
    function renderPoleTypeChart() {
        const counts = {};
        filteredData.forEach(d => {
            const type = d["Type of Pole"] || "Unknown";
            counts[type] = (counts[type] || 0) + 1;
        });

        const data = Object.keys(counts).map(key => {
            let color = '#a0a0a0';
            const upper = key.toUpperCase();
            if (upper.includes('CONCRETE')) color = '#10b981';
            if (upper.includes('WOOD')) color = '#ef4444';

            return {
                name: key,
                y: counts[key],
                color: color
            };
        });

        if (typeof Highcharts === 'undefined') { console.warn('Highcharts not loaded, skipping pole type chart'); return; }
        Highcharts.chart('poleTypeChart', {
            chart: {
                type: 'pie',
                backgroundColor: 'rgba(0,0,0,0)',
                options3d: {
                    enabled: true,
                    alpha: 45
                }
            },
            title: {
                text: null
            },
            tooltip: {
                pointFormat: '{series.name}: <b>{point.percentage:.1f}%</b>'
            },
            plotOptions: {
                pie: {
                    innerSize: 0,
                    depth: 45,
                    allowPointSelect: true,
                    cursor: 'pointer',
                    dataLabels: {
                        enabled: true,
                        format: '<b>{point.name}</b>: {point.percentage:.1f} %',
                        style: {
                            color: '#e4e5e7',
                            textOutline: 'none'
                        }
                    },
                    showInLegend: true
                }
            },
            series: [{
                name: 'Distribution',
                data: data
            }],
            credits: {
                enabled: false
            }
        });
    }

    // 3.5 Issues by Staff (Stacked Bar)
    function renderStaffIssuesChart() {
        // Group by User -> Issue Type -> Count
        const userIssues = {};
        const issuesSet = new Set();

        filteredData.forEach(d => {
            const user = d.User;
            const issue = d.Issue_Type;
            if (issue === 'Good Condition') return; // Filter out 'Good' to focus on issues? Or keep all? Prompt implies distinct issues. Let's filter 'Good' to make it look like the example "Reported Issues".

            issuesSet.add(issue);
            if (!userIssues[user]) userIssues[user] = {};
            userIssues[user][issue] = (userIssues[user][issue] || 0) + 1;
        });

        const issueTypes = Array.from(issuesSet); // e.g. Broken, Crooked...

        // Sort users by total issues
        const sortedUsers = Object.keys(userIssues).sort((a, b) => {
            const totalA = Object.values(userIssues[a]).reduce((s, c) => s + c, 0);
            const totalB = Object.values(userIssues[b]).reduce((s, c) => s + c, 0);
            return totalB - totalA;
        });

        // Prepare Traces (one per issue type)
        const traces = issueTypes.map(issue => {
            return {
                x: sortedUsers.map(u => getDisplayName(u)),
                y: sortedUsers.map(u => userIssues[u][issue] || 0),
                name: issue,
                type: 'bar'
            };
        });

        const layout = {
            barmode: 'stack',
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#e4e5e7' },
            xaxis: { title: '', tickangle: -45 },
            yaxis: { title: 'Number of Issues' },
            margin: { t: 30, b: 100, l: 50, r: 20 },
            legend: { orientation: 'h', y: 1.1 }
        };

        Plotly.newPlot('staffIssuesChart', traces, layout, { responsive: true });
    }

    // 4. Undertaking Breakdown (Bar Chart - Horizontal)
    function renderUndertakingChart() {
        const counts = {};
        filteredData.forEach(d => {
            counts[d["Undertaking"]] = (counts[d["Undertaking"]] || 0) + 1;
        });

        const sorted = Object.entries(counts).sort((a, b) => a[1] - b[1]); // Ascending for horizontal bar
        const y = sorted.map(i => i[0]);
        const x = sorted.map(i => i[1]);

        const trace = {
            x: x,
            y: y,
            type: 'bar',
            orientation: 'h',
            marker: {
                color: '#f59e0b'
            }
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#e4e5e7' },
            margin: { t: 20, l: 100, r: 20, b: 40 },
            xaxis: { title: 'Count' }
        };

        Plotly.newPlot('undertakingChart', [trace], layout, { responsive: true });
    }

    // 5. Vendor Performance Comparison (Total Records & Run Rate)
    function renderVendorPerformanceCharts() {
        // Track records and unique (User + Date) combinations for Man-Days
        const vendorData = {
            'ETC Workforce': { records: 0, manDays: new Set() },
            'Jesom Technology': { records: 0, manDays: new Set() },
            'Ikeja Electric': { records: 0, manDays: new Set() }
        };

        filteredData.forEach(d => {
            const vendor = d.Vendor_Name;
            const date = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : 'Unknown';
            const user = d.User;

            if (vendorData[vendor]) {
                vendorData[vendor].records++;
                vendorData[vendor].manDays.add(`${user}|${date}`); // Unique Man-Day
            }
        });

        const vendors = ['ETC Workforce', 'Jesom Technology', 'Ikeja Electric'];

        // Data for Chart 1: Total Records
        const totalRecords = vendors.map(v => vendorData[v].records);

        // Data for Chart 2: Avg Run Rate per Field Officer (Records / Man-Days)
        const runRates = vendors.map(v => {
            const days = vendorData[v].manDays.size || 1;
            return (vendorData[v].records / days);
        });

        const blueColor = '#0EA5E9'; // e.g. bright blue
        const redColor = '#f97316'; // Jesom Orange (formerly red)
        const greenColor = '#10b981'; // Ikeja Green

        // --- Chart 1: Total Records ---
        const traceTotal = {
            x: vendors,
            y: totalRecords,
            type: 'bar',
            text: totalRecords.map(String),
            textposition: 'auto',
            marker: {
                color: [blueColor, redColor, greenColor]
            }
        };

        const layoutTotal = {
            title: { text: 'Total Records by Vendor', font: { color: '#e4e5e7', size: 16 } },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#fafafa' },
            xaxis: { title: '' },
            yaxis: { title: '', showgrid: true, gridcolor: '#334155' },
            margin: { t: 40, b: 40, l: 40, r: 40 }
        };

        Plotly.newPlot('vendorTotalChart', [traceTotal], layoutTotal, { responsive: true });

        // --- Chart 2: Run Rate ---
        const traceRunRate = {
            x: vendors,
            y: runRates,
            type: 'bar',
            text: runRates.map(v => v.toFixed(1)),
            textposition: 'auto',
            marker: {
                color: [blueColor, redColor, greenColor]
            },
            name: 'Run Rate'
        };

        // Target Line (50/day)
        const targetLine = {
            type: 'line',
            x0: -0.5,
            x1: 2.5,
            y0: 50,
            y1: 50,
            line: {
                color: '#10b981', // green
                width: 2,
                dash: 'dash'
            }
        };

        const layoutRunRate = {
            title: { text: 'Avg Daily Run Rate (Per Officer)', font: { color: '#e4e5e7', size: 16 } },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#fafafa' },
            xaxis: { title: '' },
            yaxis: { title: '', showgrid: true, gridcolor: '#334155', range: [0, Math.max(60, Math.max(...runRates) * 1.1)] }, // Ensure grid scale fits target line
            margin: { t: 40, b: 40, l: 40, r: 40 },
            shapes: [targetLine],
            annotations: [{
                x: 1,
                y: 52,
                xref: 'x',
                yref: 'y',
                text: 'Target: 50/day',
                showarrow: false,
                font: { color: '#10b981' }
            }]
        };

        Plotly.newPlot('vendorRunRateChart', [traceRunRate], layoutRunRate, { responsive: true });
    }


    // 6. Detailed DT Analysis Table (Enhanced)
    function renderDTTable() {
        const tbody = document.querySelector('#dtTable tbody');
        if (!tbody) return;

        tbody.innerHTML = '';
        const searchVal = (document.getElementById('dtSearchInput')?.value || '').toLowerCase();

        // 1. Get Enhanced Data (Union of BOQ and Field)
        const data = getEnhancedDTData();

        // 2. Filter by Search Input
        // 2. Filter by Search Input (Interactive)
        const filtered = data.filter(item => {
            if (!searchVal) return true;
            return (
                (item.dtName || '').toLowerCase().includes(searchVal) ||
                (item.vendor || '').toLowerCase().includes(searchVal) ||
                (item.feeder || '').toLowerCase().includes(searchVal) ||
                (item.bu || '').toLowerCase().includes(searchVal) ||
                (item.undertaking || '').toLowerCase().includes(searchVal) ||
                item.users.some(u => String(getDisplayName(u) || '').toLowerCase().includes(searchVal))
            );
        });

        // 3. Update Info Count
        const infoEl = document.getElementById('tableInfo');
        if (infoEl) infoEl.textContent = `Showing ${filtered.length} of ${data.length} DTs`;

        // 4. Pagination Logic
        const totalItems = filtered.length;
        const totalPages = Math.ceil(totalItems / rowsPerPage);

        // Adjust currentPage if out of bounds
        if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
        if (currentPage < 1 && totalPages > 0) currentPage = 1; // Should happen?
        if (totalPages === 0) currentPage = 1; // If no items, reset to page 1

        const startIndex = (currentPage - 1) * rowsPerPage;
        const endIndex = startIndex + rowsPerPage;
        const paginatedData = filtered.slice(startIndex, endIndex);

        // 5. Render Rows
        paginatedData.forEach((row, index) => {
            const tr = document.createElement('tr');

            // Vendor Tag
            let vendorClass = '';
            if (row.vendor === 'ETC Workforce') vendorClass = 'vendor-etc';
            if (row.vendor === 'Jesom Technology') vendorClass = 'vendor-jesom';

            // Progress Bar / Status Logic
            const progress = row.boqTotal > 0 ? (row.actualTotal / row.boqTotal) * 100 : 0;
            let status = 'In Progress';
            let statusColor = '#f59e0b'; // Orange

            if (row.actualTotal === 0) {
                status = 'Not Started';
                statusColor = '#ef4444'; // Red
            } else if (progress >= 100) {
                status = 'Completed';
                statusColor = '#10b981'; // Green
            } else if (progress > 90) {
                status = 'Near Completion';
                statusColor = '#3b82f6'; // Blue
            }

            // User Names
            const userNames = row.users.map(u => getDisplayName(u)).join(', ');
            // Absolute index for numbering
            const absIndex = startIndex + index + 1;

            tr.innerHTML = `
                <td class="col-index" style="text-align: center;">${absIndex}</td>
                <td class="col-dtName" style="font-weight: 500; color: #fff;">${row.dtName}</td>
                <td class="col-feeder">${row.feeder}</td>
                <td class="col-bu">${row.bu}</td>
                <td class="col-undertaking">${row.undertaking}</td>
                <td class="col-vendor"><span class="vendor-tag ${vendorClass}">${row.vendor}</span></td>
                <td class="col-users" style="max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${userNames}">${userNames}</td>
                <td class="col-boqTotal" style="text-align: center; font-weight: bold; color: #0EA5E9;">${row.boqTotal}</td>
                <td class="col-actualTotal" style="text-align: center;">${row.actualTotal}</td>
                <td class="col-remaining" style="text-align: center; color: #a0a0a0;">${Math.max(0, row.boqTotal - row.actualTotal)}</td>
                <td class="col-concrete" style="text-align: center;">${row.concrete}</td>
                <td class="col-wooden" style="text-align: center;">${row.wooden}</td>
                <td class="col-progress" style="width: 70px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <div style="flex-grow: 1; height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
                            <div style="width: ${Math.min(100, progress)}%; height: 100%; background: ${statusColor};"></div>
                        </div>
                        <span style="font-size: 0.8em; color: ${statusColor};">${progress.toFixed(0)}%</span>
                    </div>
                </td>
                <td class="col-status"><span style="font-size: 0.8em; padding: 1px 6px; border-radius: 8px; background: ${statusColor}20; color: ${statusColor}; border: 1px solid ${statusColor}40; white-space: nowrap;">${status}</span></td>
            `;
            tbody.appendChild(tr);
        });

        // 6. Render Pagination Controls
        renderPaginationControls(filtered.length);
    }

    function renderPaginationControls(totalItems) {
        const container = document.getElementById('paginationControls');
        if (!container) return;
        container.innerHTML = '';

        const totalPages = Math.ceil(totalItems / rowsPerPage);
        if (totalPages <= 1) return;

        const createBtn = (text, page, isActive = false, isDisabled = false) => {
            const btn = document.createElement('button');
            btn.className = `page-btn ${isActive ? 'active' : ''}`;
            btn.textContent = text;
            if (isDisabled) btn.disabled = true;
            else {
                btn.onclick = () => {
                    currentPage = page;
                    renderDTTable();
                };
            }
            return btn;
        };

        // Prev Button
        container.appendChild(createBtn('<', currentPage - 1, false, currentPage === 1));

        // Page Range Logic (Show up to 6 pages)
        const maxVisible = 6;
        let startPage = 1;
        let endPage = Math.min(totalPages, maxVisible);

        if (currentPage > 3 && totalPages > maxVisible) {
            // Center user in the window if possible
            startPage = Math.max(1, currentPage - 2);
            endPage = Math.min(totalPages, startPage + maxVisible - 1);

            // Adjust start if end is capped
            if (endPage === totalPages) {
                startPage = Math.max(1, endPage - maxVisible + 1);
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            container.appendChild(createBtn(i, i, i === currentPage));
        }

        // Next Button
        container.appendChild(createBtn('>', currentPage + 1, false, currentPage === totalPages));
    }

    function resetFilters() {
        // 1. Reset View Mode first
        viewMode = 'field';
        const toggle = document.getElementById('viewModeToggle');
        if (toggle) toggle.checked = false;

        // 2. Clear Search Input
        const searchInput = document.getElementById('dtSearchInput');
        if (searchInput) searchInput.value = '';

        // 3. Reset Pagination
        currentPage = 1;

        // 4. Reset Filters UI & Data
        // Re-populate from scratch (this resets options to global state)
        populateFilters();

        // Ensure all selects are set to 'All' (populateFilters might do this implicitly, but let's be sure)
        const filterIds = [
            'vendorFilter', 'buFilter', 'utFilter', 'userFilter',
            'feederFilter', 'dtFilter', 'upriserFilter', 'materialFilter', 'dateFilter'
        ];

        filterIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = 'All';
            if (multiSelects[id]) multiSelects[id].reset();
        });

        // 5. Update Dashboard (This will rebuild filteredData from globalData based on the 'All' selections)
        applyFilters();
    }

    function getEnhancedDTData() {
        const map = {};

        // 1. Process Field Data
        filteredData.forEach(d => {
            const dtName = (d["DT Name"] || "Unknown DT").trim();
            const feeder = (d["Feeder"] || "Unknown Feeder").trim();
            const key = `${feeder}|${dtName}`.toUpperCase();

            if (!map[key]) {
                map[key] = {
                    key,
                    dtName,
                    feeder,
                    bu: d["Bussines Unit"] || "-",
                    undertaking: d["Undertaking"] || "-",
                    vendor: d["Vendor_Name"] || "-",
                    users: new Set(),
                    boqTotal: 0, // Will fill from BOQ
                    newPoles: 0, // New Poles (Install)
                    actualTotal: 0,
                    concrete: 0,
                    wooden: 0
                };
            }

            map[key].actualTotal++;
            map[key].users.add(d.User);

            // New Poles (Install)
            const poleType = String(d["Pole_Type"] || d["Type of Pole"] || "").toLowerCase();
            const issueType = String(d["Issue_Type"] || "").toLowerCase();
            if (poleType.includes('new') || issueType.includes('new')) map[key].newPoles++;

            // Material
            const mat = String(d["Pole Material"] || d["Material"] || d["Pole_Material"] || "").toLowerCase();
            const type = String(d["Type of Pole"] || "").toLowerCase();
            if (mat.includes('concrete') || type.includes('concrete')) map[key].concrete++;
            if (mat.includes('wood') || type.includes('wood')) map[key].wooden++;
        });

        // 2. Process BOQ Data (Fill Targets)
        // Respect Feeder/DT filters if possible, but for "Total (BOQ)", usually we want the Static BOQ target for that DT.
        // However, we should filter BOQ by the global dashboard filters TO AN EXTENT (e.g. if I selected a Feeder, I only want DTs in that Feeder).
        // `filteredData` is already filtered. `boqData` is just raw.
        // I need to iterate `boqData` and match. 
        // Also if a DT is in BOQ but NOT in field data, we should add it?
        // Yes, to show "0 Actual" and "Status: Not Started".

        // Apply same filters to BOQ as Dashboard?
        // The dashboard filters (bu, ut, vendor...) apply to Field Data.
        // BOQ only has Feeder/DT.
        // If I filter by Vendor=ETC, I should only see DTs assigned to ETC?
        // But BOQ doesn't have Vendor.
        // Only Field Data determines Vendor.
        // So if I filter by Vendor, I implicitly filter out "Not Started" DTs because they have no Vendor assigned in Field Data yet?
        // UNLESS we have a mapping of BOQ DTs to Vendors. We don't.
        // So: If filtered by Vendor, we only show DTs that have started (have field data).
        // If NO Vendor filter (All), we show everything.
        // This suggests:
        // - Iterate field map (which respects all filters).
        // - Iterate BOQ. If BOQ item matches a key in field map, update boqTotal.
        // - IF BOQ item does NOT match field map:
        //   - IF "All" filters are selected (or at least Vendor is All), add it as "Not Started".
        //   - IF filters are active (e.g. Vendor=ETC), do NOT add it (because we don't know if it belongs to ETC).

        const selFeederVals = multiSelects.feederFilter?.getValues();
        const selDTVals = multiSelects.dtFilter?.getValues();

        boqData.forEach(d => {
            const dtName = (d["DT NAME"] || "Unknown DT").trim();
            const feeder = (d["FEEDER NAME"] || "Unknown Feeder").trim();
            const key = `${feeder}|${dtName}`.toUpperCase();

            // Check filters (Feeder/DT)
            if (selFeederVals && !selFeederVals.includes(feeder)) return;
            if (selDTVals && !selDTVals.includes(dtName)) return;


            if (map[key]) {
                // Exists in field data (so it passed field filters)
                map[key].boqTotal += (parseInt(d["POLES Grand Total"]) || 0);
            } else {
                // Not in field data.
                // Only add if we are not strictly filtering by attributes we determine from field (like Vendor, User, Material, BU, UT).
                // If I filtered by "Concrete", I can't show a BOQ-only item because I don't know if it will be concrete.
                // So, if ANY filter (other than Feeder/DT) is active, we might skip BOQ-only items to avoid showing unrelated data?
                // OR we just show them as "No Data".
                // But the user request implies a management dashboard.
                // Let's safe side: Only add BOQ-only items if NO major field-dependent filters are active.
                // Major filters: Vendor, BU, Undertaking, User, Material.

                // Active Filters Check
                const hasFieldFilter = !multiSelects.vendorFilter?.isAll() ||
                    !multiSelects.buFilter?.isAll() ||
                    !multiSelects.utFilter?.isAll() ||
                    !multiSelects.userFilter?.isAll() ||
                    !multiSelects.materialFilter?.isAll();

                if (!hasFieldFilter) {
                    map[key] = {
                        key,
                        dtName,
                        feeder,
                        bu: "-",
                        undertaking: "-",
                        vendor: "Pending", // No vendor assigned yet
                        users: [],
                        boqTotal: (parseInt(d["POLES Grand Total"]) || 0),
                        newPoles: (parseInt(d["NEW POLE"]) || 0),
                        actualTotal: 0,
                        concrete: 0,
                        wooden: 0
                    };
                }
            }
        });

        // 3. Convert Map to Array and Finalize
        return Object.values(map).map(item => ({
            ...item,
            users: Array.from(item.users)
        }));
    }

    // 6. Detailed DT Analysis Table (Enhanced)
    function renderDTTable() {
        const tbody = document.querySelector('#dtTable tbody');
        if (!tbody) return;

        tbody.innerHTML = '';
        const searchVal = (document.getElementById('dtSearchInput')?.value || '').toLowerCase();

        // 1. Get Enhanced Data (Union of BOQ and Field)
        const data = getEnhancedDTData();

        // 2. Filter by Search Input
        const filtered = data.filter(item => {
            if (!searchVal) return true;
            return (
                (item.dtName || '').toLowerCase().includes(searchVal) ||
                (item.vendor || '').toLowerCase().includes(searchVal) ||
                item.users.some(u => String(getDisplayName(u) || '').toLowerCase().includes(searchVal))
            );
        });

        // 3. Update Info Count
        const infoEl = document.getElementById('tableInfo');
        if (infoEl) infoEl.textContent = `Showing ${filtered.length} of ${data.length} DTs`;

        // 4. Render Rows
        // 4. Pagination Logic
        const totalRows = filtered.length;
        const totalPages = Math.ceil(totalRows / rowsPerPage);

        // Ensure currentPage is valid
        if (currentPage > totalPages) currentPage = Math.max(1, totalPages);

        const startIndex = (currentPage - 1) * rowsPerPage;
        const endIndex = startIndex + rowsPerPage;

        const paginatedRows = filtered.slice(startIndex, endIndex);

        // 4b. Render Rows
        paginatedRows.forEach((row, index) => {
            const tr = document.createElement('tr');
            const globalIndex = startIndex + index + 1;

            // Vendor Tag
            let vendorClass = '';
            if (row.vendor === 'ETC Workforce') vendorClass = 'vendor-etc';
            if (row.vendor === 'Jesom Technology') vendorClass = 'vendor-jesom';

            // Progress Bar / Status Logic
            const progress = row.boqTotal > 0 ? (row.actualTotal / row.boqTotal) * 100 : 0;
            let status = 'In Progress';
            let statusColor = '#f59e0b'; // Orange

            if (row.actualTotal === 0) {
                status = 'Not Started';
                statusColor = '#ef4444'; // Red
            } else if (progress >= 100) {
                status = 'Completed';
                statusColor = '#10b981'; // Green
            } else if (progress > 90) {
                status = 'Near Completion';
                statusColor = '#3b82f6'; // Blue
            }

            // User Names
            const userNames = row.users.map(u => getDisplayName(u)).join(', ');

            // Add classes for column visibility
            tr.innerHTML = `
                <td class="col-index" style="text-align: center;">${globalIndex}</td>
                <td class="col-dtName" style="font-weight: 500; color: #fff;">${row.dtName}</td>
                <td class="col-feeder">${row.feeder}</td>
                <td class="col-bu">${row.bu}</td>
                <td class="col-undertaking">${row.undertaking}</td>
                <td class="col-vendor"><span class="vendor-tag ${vendorClass}">${row.vendor}</span></td>
                <td class="col-users" style="max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${userNames}">${userNames}</td>
                <td class="col-boqTotal" style="text-align: center; font-weight: bold; color: #0EA5E9;">${row.boqTotal}</td>
                <td class="col-newPoles" style="text-align: center; color: #a855f7; font-weight: 600;">${row.newPoles || 0}</td>
                <td class="col-actualTotal" style="text-align: center;">${row.actualTotal}</td>
                <td class="col-remaining" style="text-align: center; color: #a0a0a0;">${Math.max(0, row.boqTotal - row.actualTotal)}</td>
                <td class="col-concrete" style="text-align: center;">${row.concrete}</td>
                <td class="col-wooden" style="text-align: center;">${row.wooden}</td>
                <td class="col-progress" style="width: 70px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <div style="flex-grow: 1; height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
                            <div style="width: ${Math.min(100, progress)}%; height: 100%; background: ${statusColor};"></div>
                        </div>
                        <span style="font-size: 0.8em; color: ${statusColor};">${progress.toFixed(0)}%</span>
                    </div>
                </td>
                <td class="col-status"><span style="font-size: 0.8em; padding: 1px 6px; border-radius: 8px; background: ${statusColor}20; color: ${statusColor}; border: 1px solid ${statusColor}40; white-space: nowrap;">${status}</span></td>
            `;
            tbody.appendChild(tr);
        });

        // 5. Update Info & Render Pagination Controls
        if (infoEl) infoEl.textContent = `Showing ${startIndex + 1}-${Math.min(endIndex, totalRows)} of ${totalRows} DTs`;
        renderPaginationControls(totalPages);
    }

    function renderPaginationControls(totalPages) {
        const container = document.getElementById('paginationControls');
        if (!container) return;

        container.innerHTML = '';
        if (totalPages <= 1) return;

        // Prev Button
        const prevBtn = document.createElement('button');
        prevBtn.className = 'page-btn';
        prevBtn.innerHTML = '&lt;'; // <
        prevBtn.disabled = currentPage === 1;
        prevBtn.onclick = () => {
            if (currentPage > 1) {
                currentPage--;
                renderDTTable();
            }
        };
        container.appendChild(prevBtn);

        // Page Numbers (Smart display: First, Last, Current +/- 1)
        const pagesToShow = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
        const sortedPages = [...pagesToShow].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

        let lastPage = 0;
        sortedPages.forEach(p => {
            if (lastPage > 0 && p - lastPage > 1) {
                // Ellipsis
                const span = document.createElement('span');
                span.className = 'page-ellipsis';
                span.textContent = '...';
                span.style.color = '#64748b';
                container.appendChild(span);
            }

            const btn = document.createElement('button');
            btn.className = `page-btn ${p === currentPage ? 'active' : ''}`;
            btn.textContent = p;
            btn.onclick = () => {
                currentPage = p;
                renderDTTable();
            };
            container.appendChild(btn);
            lastPage = p;
        });

        // Next Button
        const nextBtn = document.createElement('button');
        nextBtn.className = 'page-btn';
        nextBtn.innerHTML = '&gt;'; // >
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.onclick = () => {
            if (currentPage < totalPages) {
                currentPage++;
                renderDTTable();
            }
        };
        container.appendChild(nextBtn);
    }



    function renderFeederChart() {
        const counts = {};
        filteredData.forEach(d => {
            const val = d.Feeder || "Unknown";
            counts[val] = (counts[val] || 0) + 1;
        });

        // Top 10 Feeders
        const sorted = Object.entries(counts).sort((a, b) => a[1] - b[1]).slice(-10);
        const y = sorted.map(d => d[0]);
        const x = sorted.map(d => d[1]);

        const trace = {
            x: x,
            y: y,
            type: 'bar',
            orientation: 'h',
            marker: { color: '#8b5cf6' } // Purple
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#e4e5e7' },
            margin: { l: 200, t: 30, b: 50, r: 20 },
            xaxis: { title: 'Count' },
            yaxis: { automargin: true }
        };

        const config = { responsive: true, displayModeBar: false };
        Plotly.newPlot('feederChart', [trace], layout, config);
    }

    // Map control: search bar with datalist intellisense over Pole IDs / DT names / Feeders
    function addMapSearchControl() {
        const SearchControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'map-search-control leaflet-bar');
                container.innerHTML = `
                    <input type="text" id="mapSearchInput" list="mapSearchSuggestions" placeholder="Search pole / DT / feeder…" autocomplete="off">
                    <datalist id="mapSearchSuggestions"></datalist>
                    <button type="button" id="mapSearchClear" title="Clear">&times;</button>
                `;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
                return container;
            }
        });
        new SearchControl().addTo(map);

        // Wire up search behavior after DOM exists
        setTimeout(() => {
            const input = document.getElementById('mapSearchInput');
            const clearBtn = document.getElementById('mapSearchClear');
            const dataList = document.getElementById('mapSearchSuggestions');
            if (!input || !dataList) return;

            // Populate suggestions from current filteredData
            const populate = () => {
                const set = new Set();
                (filteredData || []).forEach(d => {
                    if (d["Lt PoleSLRN"]) set.add(String(d["Lt PoleSLRN"]));
                    if (d["LT Pole No"]) set.add(String(d["LT Pole No"]));
                    if (d["DT Name"]) set.add(String(d["DT Name"]));
                    if (d.Feeder) set.add(String(d.Feeder));
                });
                dataList.innerHTML = [...set].slice(0, 500).map(v => `<option value="${v.replace(/"/g, '&quot;')}">`).join('');
            };
            populate();
            window._refreshMapSearchSuggestions = populate;

            const runSearch = () => {
                const q = (input.value || '').trim().toLowerCase();
                if (!q) return;
                const hit = (filteredData || []).find(d => {
                    return String(d["Lt PoleSLRN"] || '').toLowerCase() === q
                        || String(d["LT Pole No"] || '').toLowerCase() === q
                        || String(d["DT Name"] || '').toLowerCase() === q
                        || String(d.Feeder || '').toLowerCase() === q;
                });
                if (hit && !isNaN(parseFloat(hit.Latitude)) && !isNaN(parseFloat(hit.Longitude))) {
                    highlightSearchTarget(parseFloat(hit.Latitude), parseFloat(hit.Longitude));
                } else {
                    input.classList.add('map-search-miss');
                    setTimeout(() => input.classList.remove('map-search-miss'), 700);
                }
            };

            input.addEventListener('change', runSearch);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
            clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); });
        }, 0);
    }

    // Compute the LatLngBounds of all data points matching the current
    // cascaded selection (BU → UT → Feeder → DT) and fly the map there.
    // Called whenever the user changes any of those four filter groups.
    function zoomToCurrentSelection(triggerFilterId) {
        if (!map || !globalData) return;

        // The filter that was just changed must have at least one selection
        // for us to zoom — otherwise the user effectively cleared it.
        const triggerSel = multiSelects[triggerFilterId]?.selectedValues;
        if (!triggerSel || triggerSel.size === 0) return;

        const buSel     = multiSelects.buFilter?.selectedValues;
        const utSel     = multiSelects.utFilter?.selectedValues;
        const feederSel = multiSelects.feederFilter?.selectedValues;
        const dtSel     = multiSelects.dtFilter?.selectedValues;
        const applies = (set, v) => !set || set.size === 0 || set.has(v);

        const latlngs = [];
        globalData.forEach(d => {
            if (!applies(buSel,     d["Bussines Unit"])) return;
            if (!applies(utSel,     d["Undertaking"]))   return;
            if (!applies(feederSel, d["Feeder"]))        return;
            if (!applies(dtSel,     d["DT Name"]))       return;
            const lat = parseFloat(d.Latitude), lon = parseFloat(d.Longitude);
            if (!isNaN(lat) && !isNaN(lon)) latlngs.push([lat, lon]);
        });

        if (latlngs.length === 0) return;
        const bounds = L.latLngBounds(latlngs);
        try {
            map.flyToBounds(bounds, { duration: 1.6, padding: [40, 40], maxZoom: 17 });
        } catch (e) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
        }
    }

    // Map control: collapsible filter panel mirroring the sidebar filters
    function addMapFilterControl() {
        const FilterControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'map-filter-control leaflet-bar');
                container.innerHTML = `
                    <button type="button" id="mapFilterToggle" class="map-filter-toggle" title="Map filters">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                        <span>Filters</span>
                    </button>
                    <div class="map-filter-panel" id="mapFilterPanel" style="display:none;"></div>
                `;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
                return container;
            }
        });
        new FilterControl().addTo(map);

        setTimeout(() => {
            const toggle = document.getElementById('mapFilterToggle');
            const panel = document.getElementById('mapFilterPanel');
            if (!toggle || !panel) return;

            // Sources: 6 filters whose real state lives inside the MultiSelect
            // instances registered at the top of this IIFE. We manipulate
            // .selectedValues directly and call the instance's onChange() to
            // trigger applyFilters(), same pathway as the sidebar.
            const sourceMap = [
                { key: 'bu',     label: 'Business Unit', filterId: 'buFilter' },
                { key: 'ut',     label: 'Undertaking',   filterId: 'utFilter' },
                { key: 'feeder', label: 'Feeder',        filterId: 'feederFilter' },
                { key: 'dt',     label: 'DT Name',       filterId: 'dtFilter' },
                { key: 'vendor', label: 'Vendor',        filterId: 'vendorFilter' },
                { key: 'user',   label: 'User',          filterId: 'userFilter' }
            ];

            // Map each filter to the underlying data field so we can cascade:
            // BU → UT → Feeder → DT → Vendor → User. Each group's options
            // are computed from globalData filtered by all upstream selections,
            // giving true cascading dropdowns.
            const fieldFor = {
                buFilter:     'Bussines Unit',
                utFilter:     'Undertaking',
                feederFilter: 'Feeder',
                dtFilter:     'DT Name',
                vendorFilter: 'Vendor_Name',
                userFilter:   'User'
            };
            const cascadeOrder = ['buFilter', 'utFilter', 'feederFilter', 'dtFilter', 'vendorFilter', 'userFilter'];

            const applies = (set, v) => !set || set.size === 0 || set.has(v);

            // Returns the sorted unique values for `targetFilterId`, filtered by
            // all upstream selections in the cascade.
            const optionsForFilter = (targetFilterId) => {
                const upstreamFilters = cascadeOrder.slice(0, cascadeOrder.indexOf(targetFilterId));
                const out = new Set();
                (globalData || []).forEach(d => {
                    for (const upId of upstreamFilters) {
                        const ms = multiSelects[upId];
                        const fld = fieldFor[upId];
                        if (!applies(ms?.selectedValues, d[fld])) return;
                    }
                    const v = d[fieldFor[targetFilterId]];
                    if (v !== undefined && v !== null && v !== '') out.add(String(v));
                });
                return [...out].sort((a, b) => a.localeCompare(b));
            };

            // When upstream changes, drop any downstream selectedValues that
            // are no longer valid under the new cascade.
            const pruneDownstream = (changedFilterId) => {
                const idx = cascadeOrder.indexOf(changedFilterId);
                for (let i = idx + 1; i < cascadeOrder.length; i++) {
                    const ms = multiSelects[cascadeOrder[i]];
                    if (!ms) continue;
                    const validSet = new Set(optionsForFilter(cascadeOrder[i]));
                    let changed = false;
                    [...ms.selectedValues].forEach(v => {
                        if (!validSet.has(v)) { ms.selectedValues.delete(v); changed = true; }
                    });
                    if (changed && typeof ms.refresh === 'function') ms.refresh();
                }
            };

            const buildPanel = () => {
                panel.innerHTML = sourceMap.map(src => {
                    const ms = multiSelects[src.filterId];
                    if (!ms) return '';
                    const values = optionsForFilter(src.filterId);
                    const checks = values.map(v => {
                        const safe = String(v).replace(/"/g, '&quot;');
                        const checked = ms.selectedValues.has(v) ? 'checked' : '';
                        const label = src.filterId === 'userFilter' ? getDisplayName(v) : v;
                        return `<label class="map-filter-check"><input type="checkbox" data-filter="${src.filterId}" value="${safe}" ${checked}><span>${label}</span></label>`;
                    }).join('');
                    return `
                        <div class="map-filter-group" data-filter="${src.filterId}">
                            <div class="map-filter-group-head">
                                <span>${src.label}</span>
                                <span class="map-filter-actions">
                                    <button type="button" class="map-filter-sel-all">All</button>
                                    <button type="button" class="map-filter-sel-none">None</button>
                                </span>
                            </div>
                            <div class="map-filter-options">${checks || '<em>(no options)</em>'}</div>
                        </div>
                    `;
                }).join('');

                panel.querySelectorAll('.map-filter-group').forEach(group => {
                    const filterId = group.dataset.filter;
                    const ms = multiSelects[filterId];
                    if (!ms) return;

                    const syncAfterChange = () => {
                        pruneDownstream(filterId);
                        if (typeof ms.refresh === 'function') ms.refresh();
                        if (typeof ms.onChange === 'function') ms.onChange();
                        buildPanel();
                        // When the user narrows by BU, UT, Feeder, or DT,
                        // zoom the map to the coverage area of the resulting
                        // cascaded selection.
                        if (['buFilter', 'utFilter', 'feederFilter', 'dtFilter'].includes(filterId)) {
                            zoomToCurrentSelection(filterId);
                        }
                    };

                    group.querySelector('.map-filter-sel-all').addEventListener('click', () => {
                        // Check every currently-available (cascaded) option.
                        optionsForFilter(filterId).forEach(v => ms.selectedValues.add(v));
                        syncAfterChange();
                    });

                    group.querySelector('.map-filter-sel-none').addEventListener('click', () => {
                        ms.selectedValues.clear();
                        syncAfterChange();
                    });

                    group.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                        cb.addEventListener('change', () => {
                            if (cb.checked) ms.selectedValues.add(cb.value);
                            else ms.selectedValues.delete(cb.value);
                            syncAfterChange();
                        });
                    });
                });
            };

            toggle.addEventListener('click', () => {
                const showing = panel.style.display !== 'none';
                panel.style.display = showing ? 'none' : 'block';
                if (!showing) buildPanel();
            });
        }, 0);
    }

    // Map control: circular magnifier lens that follows the cursor.
    // When toggled on, a small inset Leaflet map tracks the pointer and
    // displays the area beneath it at a higher zoom level, so the user
    // can inspect dense marker clusters without committing to a zoom.
    function addMapZoomLensControl() {
        const ZoomLensControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'map-zoom-lens-control leaflet-bar');
                container.innerHTML = `<button type="button" id="mapZoomLensToggle" title="Toggle zoom lens (magnifier)">🔍+</button>`;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
                return container;
            }
        });
        new ZoomLensControl().addTo(map);

        setTimeout(() => {
            const btn = document.getElementById('mapZoomLensToggle');
            const mapEl = document.getElementById('map');
            if (!btn || !mapEl) return;

            const LENS_SIZE = 190;
            const LENS_ZOOM_DELTA = 3;

            let active = false;
            let lensEl = null;
            let lensMap = null;
            let lensTile = null;

            // Mirror whichever base layer the main map is currently showing,
            // so the lens content always matches (OSM / Satellite / Hybrid).
            const currentBase = {
                url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                opts: { maxZoom: 19 }
            };
            map.on('baselayerchange', (e) => {
                if (e.layer && e.layer._url) {
                    currentBase.url = e.layer._url;
                    currentBase.opts = {
                        subdomains: e.layer.options.subdomains,
                        maxZoom: e.layer.options.maxZoom || 20
                    };
                    if (lensMap && lensTile) {
                        lensMap.removeLayer(lensTile);
                        lensTile = L.tileLayer(currentBase.url, currentBase.opts).addTo(lensMap);
                    }
                }
            });

            const createLens = () => {
                lensEl = document.createElement('div');
                lensEl.className = 'map-zoom-lens';
                lensEl.style.width = LENS_SIZE + 'px';
                lensEl.style.height = LENS_SIZE + 'px';
                lensEl.style.display = 'none';
                mapEl.appendChild(lensEl);

                lensMap = L.map(lensEl, {
                    zoomControl: false,
                    attributionControl: false,
                    dragging: false,
                    scrollWheelZoom: false,
                    doubleClickZoom: false,
                    boxZoom: false,
                    keyboard: false,
                    touchZoom: false,
                    fadeAnimation: false,
                    zoomAnimation: false,
                    markerZoomAnimation: false,
                    inertia: false
                }).setView(map.getCenter(), Math.min(map.getZoom() + LENS_ZOOM_DELTA, 20));
                lensTile = L.tileLayer(currentBase.url, currentBase.opts).addTo(lensMap);
            };

            const destroyLens = () => {
                if (lensMap) { try { lensMap.remove(); } catch (e) {} }
                lensMap = null;
                lensTile = null;
                if (lensEl && lensEl.parentNode) lensEl.parentNode.removeChild(lensEl);
                lensEl = null;
            };

            const onMove = (e) => {
                if (!lensEl || !lensMap) return;
                const rect = mapEl.getBoundingClientRect();
                const x = e.originalEvent.clientX - rect.left;
                const y = e.originalEvent.clientY - rect.top;
                lensEl.style.left = (x - LENS_SIZE / 2) + 'px';
                lensEl.style.top  = (y - LENS_SIZE / 2) + 'px';
                lensEl.style.display = 'block';
                const targetZoom = Math.min(map.getZoom() + LENS_ZOOM_DELTA, currentBase.opts.maxZoom || 20);
                lensMap.setView(e.latlng, targetZoom, { animate: false });
            };
            const onOut = () => { if (lensEl) lensEl.style.display = 'none'; };
            const onZoom = () => {
                if (!lensMap) return;
                const targetZoom = Math.min(map.getZoom() + LENS_ZOOM_DELTA, currentBase.opts.maxZoom || 20);
                lensMap.setZoom(targetZoom, { animate: false });
            };

            btn.addEventListener('click', () => {
                active = !active;
                btn.classList.toggle('active', active);
                mapEl.classList.toggle('zoom-lens-active', active);
                if (active) {
                    createLens();
                    map.on('mousemove', onMove);
                    map.on('mouseout', onOut);
                    map.on('zoomend', onZoom);
                } else {
                    map.off('mousemove', onMove);
                    map.off('mouseout', onOut);
                    map.off('zoomend', onZoom);
                    destroyLens();
                }
            });
        }, 0);
    }

    // 7. Render Map (Leaflet)
    function renderMap() {
        if (!map) {
            // Init map — default view centers on Lagos; boundary fit will take over once loaded
            map = L.map('map', { zoomControl: true }).setView([6.55, 3.45], 10);

            // Base layers — OSM, Google Satellite, Google Hybrid
            const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; OpenStreetMap contributors',
                maxZoom: 19
            });
            const satLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
                subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
                attribution: '&copy; Google',
                maxZoom: 20
            });
            const hybridLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
                subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
                attribution: '&copy; Google',
                maxZoom: 20
            });
            osmLayer.addTo(map);
            L.control.layers(
                { 'OpenStreetMap': osmLayer, 'Satellite': satLayer, 'Hybrid': hybridLayer },
                null,
                { position: 'topright', collapsed: false }
            ).addTo(map);

            // Add search + filter controls (built once, data populated on every render)
            addMapSearchControl();
            addMapFilterControl();
            addMapZoomLensControl();

            // Layer order: boundaries (bottom) → labels → data markers (top)
            // Layer order (bottom → top): polygons → HT lines → UT labels
            //                              → ISS markers → TCN markers → data point markers
            boundaryLayer = L.layerGroup().addTo(map);
            htFeederLayer = L.layerGroup().addTo(map);
            utLabelLayer = L.layerGroup().addTo(map);
            issLayer = L.layerGroup().addTo(map);
            tcnLayer = L.layerGroup().addTo(map);
            markersLayer = L.layerGroup().addTo(map);

            // Hide UT text labels at far-out zooms to avoid clutter
            const mapEl = document.getElementById('map');
            const updateLabelVisibility = () => {
                mapEl.classList.toggle('ut-labels-hidden', map.getZoom() < 11);
            };
            map.on('zoomend', updateLabelVisibility);

            // Load boundary overlays once, then re-run the render so markers
            // exist at the moment we compute data bounds / trigger the pulse.
            loadBoundaries().then(() => {
                updateLabelVisibility();
                setTimeout(() => map.invalidateSize(), 50);
                renderMap(); // second pass now that boundaries are in place
            });
        }

        // Render data markers (rebuilt on every filter change)
        markersLayer.clearLayers();
        let count = 0;
        const limit = 3000; // Performance limit
        const dataLatLngs = [];

        filteredData.forEach(d => {
            if (count > limit) return;

            const lat = parseFloat(d.Latitude);
            const lon = parseFloat(d.Longitude);

            if (!isNaN(lat) && !isNaN(lon)) {
                let color = '#a0a0a0';
                if (d.Vendor_Name === 'ETC Workforce') color = '#0EA5E9';
                if (d.Vendor_Name === 'Jesom Technology') color = '#EF4444';
                if (d.Vendor_Name === 'Ikeja Electric') color = '#eab308';

                const marker = L.circleMarker([lat, lon], {
                    radius: 6,
                    fillColor: color,
                    color: '#fff',
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.85,
                    className: 'data-point-marker' // enables CSS pulse animation
                });
                dataLatLngs.push([lat, lon]);

                const captureDate = d["Date/timestamp"] ? String(d["Date/timestamp"]).split(' ')[0] : "N/A";
                const val = (v) => (v === undefined || v === null || v === '') ? 'N/A' : String(v);
                const poleId = val(d["Lt PoleSLRN"] || d["LT Pole No"]);
                const popupContent = `
                    <div class="asset-popup">
                        <div class="asset-popup-title">${poleId}</div>
                        <div class="asset-popup-divider"></div>
                        <div class="asset-popup-table">
                            <div class="asset-popup-row"><div class="asset-popup-label">Pole ID</div><div class="asset-popup-value">${poleId}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">Business Unit</div><div class="asset-popup-value">${val(d["Bussines Unit"])}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">Undertaking</div><div class="asset-popup-value">${val(d["Undertaking"])}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">Feeder</div><div class="asset-popup-value">${val(d["Feeder"])}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">DT Name</div><div class="asset-popup-value">${val(d["DT Name"])}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">Vendor</div><div class="asset-popup-value">${val(d["Vendor_Name"])}</div></div>
                            <div class="asset-popup-row"><div class="asset-popup-label">User</div><div class="asset-popup-value">${val(getDisplayName(d["User"]))}</div></div>
                            <div class="asset-popup-row asset-popup-row-last"><div class="asset-popup-label">Date</div><div class="asset-popup-value">${captureDate}</div></div>
                        </div>
                    </div>
                `;
                marker.bindPopup(popupContent, {
                    className: 'asset-popup-wrapper',
                    maxWidth: 320,
                    minWidth: 260,
                    closeButton: true,
                    autoPan: true
                });
                markersLayer.addLayer(marker);
                count++;
            }
        });

        // Refresh search suggestions whenever data is re-rendered
        if (typeof window._refreshMapSearchSuggestions === 'function') {
            window._refreshMapSearchSuggestions();
        }

        // Frame the map to a wide Lagos-State regional view on first render,
        // so the user can see the whole operating area (Lagos + neighbouring
        // states + the UT polygons) before drilling in.
        if (!mapInitiallyFitted) {
            try {
                // Lagos State centroid, wide regional zoom level
                map.flyTo([6.55, 3.55], 8, {
                    duration: 2.8,
                    easeLinearity: 0.25
                });
                mapInitiallyFitted = true;
                startMarkerPulse(20000);
            } catch (e) {
                console.warn("flyTo failed", e);
                map.setView([6.55, 3.55], 8);
                mapInitiallyFitted = true;
                startMarkerPulse(20000);
            }
        } else if (mapInitiallyFitted && count > 0) {
            // Filter change after the reveal — re-pulse, don't re-zoom
            startMarkerPulse(20000);
        }
    }

    // Pulse the data point markers for `durationMs`, then stop automatically.
    // Implemented as a CSS class toggle on #map so the scale animation runs on
    // the GPU and handles 3k markers without jank. A JS timer clears the class
    // when the duration expires.
    function startMarkerPulse(durationMs) {
        const mapEl = document.getElementById('map');
        if (!mapEl) return;
        if (pulseTimer) clearTimeout(pulseTimer);
        mapEl.classList.remove('pulsing');
        void mapEl.offsetWidth; // force reflow to restart the keyframe timeline
        mapEl.classList.add('pulsing');
        pulseTimer = setTimeout(() => {
            mapEl.classList.remove('pulsing');
            pulseTimer = null;
        }, durationMs);
    }

    // Highlight a search hit for 20 seconds: drop a pulsating halo marker
    // and oscillate the map zoom between a close-up and a wider view so
    // the target breathes in and out.
    let searchHighlightLayer = null;
    let searchHighlightInterval = null;
    let searchHighlightTimeout = null;
    function highlightSearchTarget(lat, lon) {
        if (!map) return;
        // Clean up any prior highlight
        if (searchHighlightLayer) { map.removeLayer(searchHighlightLayer); searchHighlightLayer = null; }
        if (searchHighlightInterval) { clearInterval(searchHighlightInterval); searchHighlightInterval = null; }
        if (searchHighlightTimeout) { clearTimeout(searchHighlightTimeout); searchHighlightTimeout = null; }

        // Drop a pulsating halo marker at the target
        const icon = L.divIcon({
            className: 'search-highlight-marker',
            html: '<div class="search-highlight-ring"></div><div class="search-highlight-ring delay-1"></div><div class="search-highlight-core"></div>',
            iconSize: [60, 60],
            iconAnchor: [30, 30]
        });
        searchHighlightLayer = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);

        // Initial fly to a close zoom
        const zoomClose = 18;
        const zoomFar = 15;
        map.flyTo([lat, lon], zoomClose, { duration: 1.4 });

        // Oscillate zoom in / out for the duration
        const periodMs = 3400; // one full in→out cycle
        let phase = 0;
        searchHighlightInterval = setInterval(() => {
            phase = 1 - phase;
            map.flyTo([lat, lon], phase === 0 ? zoomClose : zoomFar, { duration: periodMs / 1000, easeLinearity: 0.3 });
        }, periodMs);

        // Stop after 20 seconds
        searchHighlightTimeout = setTimeout(() => {
            if (searchHighlightInterval) { clearInterval(searchHighlightInterval); searchHighlightInterval = null; }
            if (searchHighlightLayer) { map.removeLayer(searchHighlightLayer); searchHighlightLayer = null; }
            searchHighlightTimeout = null;
        }, 20000);
    }

    // Load Lagos + UT boundary GeoJSONs once, draw styled polygons, and add labels.
    async function loadBoundaries() {
        if (boundariesLoaded) return;
        try {
            const bust = '?v=' + Date.now();
            const [lagosData, utData, htData, issData, tcnData] = await Promise.all([
                fetch('./data/lagos_boundary.geojson' + bust).then(r => r.json()),
                fetch('./data/ut_boundaries.geojson' + bust).then(r => r.json()),
                fetch('./data/shomolu_ht_feeders.geojson' + bust).then(r => r.json()),
                fetch('./data/iss_substations.geojson' + bust).then(r => r.json()),
                fetch('./data/tcn_stations.geojson' + bust).then(r => r.json())
            ]);

            // Lagos outer boundary — bold RED outline, fully visible, no fill
            const lagosGeo = L.geoJSON(lagosData, {
                style: {
                    color: '#dc2626',
                    weight: 5,
                    opacity: 1,
                    fillOpacity: 0,
                    lineCap: 'round',
                    lineJoin: 'round'
                },
                interactive: false
            }).addTo(boundaryLayer);

            // Lagos name tag, anchored at the top of its bounds for a polished header feel
            const lagosBounds = lagosGeo.getBounds();
            const lagosTop = L.latLng(lagosBounds.getNorth(), lagosBounds.getCenter().lng);
            L.marker(lagosTop, {
                interactive: false,
                keyboard: false,
                icon: L.divIcon({
                    className: 'lagos-label-wrapper',
                    html: '<div class="lagos-label">LAGOS STATE</div>',
                    iconSize: [0, 0]
                })
            }).addTo(boundaryLayer);

            // Assign a distinct color per UT up front so style() and onEachFeature
            // read from a single source of truth.
            utData.features.forEach((f, i) => {
                f.properties._color = utColorFor(i);
            });

            // UT boundaries — 54 distinct colors, visible fill, bold outline
            const utGeo = L.geoJSON(utData, {
                style: (feat) => {
                    const col = feat.properties._color;
                    return {
                        color: col,
                        weight: 2.2,
                        opacity: 1,
                        fillColor: col,
                        fillOpacity: 0.28,
                        lineJoin: 'round'
                    };
                },
                onEachFeature: (feat, layer) => {
                    const name = feat.properties.Name || feat.properties.UT || '';
                    const bu = feat.properties.BU || '';
                    const col = feat.properties._color;

                    layer.on('mouseover', e => {
                        e.target.setStyle({ fillOpacity: 0.45, weight: 3.2 });
                        e.target.bringToFront();
                    });
                    layer.on('mouseout', e => {
                        utGeo.resetStyle(e.target);
                    });

                    const buildUtPopup = () => {
                        const utRows = (filteredData || []).filter(r => (r["Undertaking"] || '').toString().toUpperCase() === name.toUpperCase());
                        const first = (arr) => {
                            const v = arr.find(x => x !== undefined && x !== null && x !== '');
                            return v === undefined ? 'N/A' : String(v);
                        };
                        const feeder = first(utRows.map(r => r.Feeder));
                        const dtName = first(utRows.map(r => r["DT Name"]));
                        const vendor = first(utRows.map(r => r.Vendor_Name));
                        const userName = first(utRows.map(r => getDisplayName(r.User)));
                        const date = first(utRows.map(r => r["Date/timestamp"] ? String(r["Date/timestamp"]).split(' ')[0] : ''));
                        return `
                            <div class="asset-popup">
                                <div class="asset-popup-title">${name || 'N/A'}</div>
                                <div class="asset-popup-divider"></div>
                                <div class="asset-popup-table">
                                    <div class="asset-popup-row"><div class="asset-popup-label">Business Unit</div><div class="asset-popup-value">${bu || 'N/A'}</div></div>
                                    <div class="asset-popup-row"><div class="asset-popup-label">Undertaking</div><div class="asset-popup-value">${name || 'N/A'}</div></div>
                                    <div class="asset-popup-row"><div class="asset-popup-label">Feeder</div><div class="asset-popup-value">${feeder}</div></div>
                                    <div class="asset-popup-row"><div class="asset-popup-label">DT Name</div><div class="asset-popup-value">${dtName}</div></div>
                                    <div class="asset-popup-row"><div class="asset-popup-label">Vendor</div><div class="asset-popup-value">${vendor}</div></div>
                                    <div class="asset-popup-row"><div class="asset-popup-label">User</div><div class="asset-popup-value">${userName}</div></div>
                                    <div class="asset-popup-row asset-popup-row-last"><div class="asset-popup-label">Date</div><div class="asset-popup-value">${date}</div></div>
                                </div>
                            </div>
                        `;
                    };

                    layer.on('click', () => layer.setPopupContent(buildUtPopup()));
                    layer.bindPopup(buildUtPopup(), {
                        className: 'asset-popup-wrapper',
                        maxWidth: 320,
                        minWidth: 260,
                        closeButton: true,
                        autoPan: true
                    });

                    // Polished centered label
                    const center = layer.getBounds().getCenter();
                    L.marker(center, {
                        interactive: false,
                        keyboard: false,
                        icon: L.divIcon({
                            className: 'ut-label-wrapper',
                            html: `<div class="ut-label" style="border-color:${col};">${name}</div>`,
                            iconSize: [0, 0]
                        })
                    }).addTo(utLabelLayer);
                }
            }).addTo(boundaryLayer);

            // ═══════════════════════════════════════════════════════════════
            // HT Feeder Lines (Shomolu) — thick orange dashed polylines
            // Rendered as two stacked layers: a wider glow underneath + a
            // bright dashed line on top, so the feeders read at all zooms.
            // ═══════════════════════════════════════════════════════════════
            L.geoJSON(htData, {
                style: {
                    color: '#f59e0b',
                    weight: 9,
                    opacity: 0.18,
                    lineCap: 'round',
                    lineJoin: 'round'
                },
                interactive: false
            }).addTo(htFeederLayer);

            const htTopGeo = L.geoJSON(htData, {
                style: {
                    color: '#fb923c',
                    weight: 3,
                    opacity: 0.95,
                    dashArray: '10, 6',
                    lineCap: 'round',
                    lineJoin: 'round',
                    className: 'ht-feeder-line'
                },
                onEachFeature: (feat, layer) => {
                    const name = feat.properties.Name || 'HT Feeder';
                    layer.bindTooltip(name, {
                        sticky: true,
                        direction: 'top',
                        className: 'ht-feeder-tooltip'
                    });
                    layer.bindPopup(`
                        <div class="asset-popup">
                            <div class="asset-popup-title">${name}</div>
                            <div class="asset-popup-subtitle">HT FEEDER LINE · SHOMOLU</div>
                            <div class="asset-popup-divider"></div>
                            <div class="asset-popup-grid">
                                <div class="asset-popup-label">Type</div>
                                <div class="asset-popup-value">11 kV HT Feeder</div>
                                <div class="asset-popup-label">Business Unit</div>
                                <div class="asset-popup-value">SHOMOLU</div>
                            </div>
                        </div>
                    `, { className: 'asset-popup-wrapper', maxWidth: 300, minWidth: 240 });
                    layer.on('mouseover', e => e.target.setStyle({ weight: 5, opacity: 1 }));
                    layer.on('mouseout', e => htTopGeo.resetStyle(e.target));
                }
            }).addTo(htFeederLayer);

            // ═══════════════════════════════════════════════════════════════
            // ISS — Injection Substations, violet diamond markers
            // ═══════════════════════════════════════════════════════════════
            issData.features.forEach(f => {
                if (!f.geometry || f.geometry.type !== 'Point') return;
                const [lon, lat] = f.geometry.coordinates;
                const name = f.properties.Name || 'Injection Substation';
                const marker = L.marker([lat, lon], {
                    icon: L.divIcon({
                        className: 'iss-marker-wrapper',
                        html: '<div class="iss-marker"><span class="iss-marker-inner"></span></div>',
                        iconSize: [18, 18],
                        iconAnchor: [9, 9]
                    }),
                    zIndexOffset: 500
                });
                marker.bindTooltip(name, { direction: 'top', offset: [0, -6], className: 'iss-tooltip' });
                marker.bindPopup(`
                    <div class="asset-popup">
                        <div class="asset-popup-title">${name}</div>
                        <div class="asset-popup-subtitle">INJECTION SUBSTATION</div>
                        <div class="asset-popup-divider"></div>
                        <div class="asset-popup-grid">
                            <div class="asset-popup-label">Asset Type</div>
                            <div class="asset-popup-value">ISS (11/33 kV)</div>
                            <div class="asset-popup-label">Coordinates</div>
                            <div class="asset-popup-value">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
                        </div>
                    </div>
                `, { className: 'asset-popup-wrapper', maxWidth: 300, minWidth: 240 });
                issLayer.addLayer(marker);
            });

            // ═══════════════════════════════════════════════════════════════
            // TCN — Transmission Company stations, gold hexagon markers
            // (the biggest, brightest markers — these are the highest-order
            // nodes in the network, so they must read at every zoom level)
            // ═══════════════════════════════════════════════════════════════
            tcnData.features.forEach(f => {
                if (!f.geometry || f.geometry.type !== 'Point') return;
                const [lon, lat] = f.geometry.coordinates;
                const name = f.properties.Name || 'TCN Station';
                const shortName = name.split(/[,\s]/)[0]; // first token for compact label
                const marker = L.marker([lat, lon], {
                    icon: L.divIcon({
                        className: 'tcn-marker-wrapper',
                        html: `<div class="tcn-marker"><span class="tcn-marker-core">T</span></div><div class="tcn-marker-label">${shortName}</div>`,
                        iconSize: [26, 26],
                        iconAnchor: [13, 13]
                    }),
                    zIndexOffset: 800
                });
                marker.bindTooltip(name, { direction: 'top', offset: [0, -12], className: 'tcn-tooltip' });
                marker.bindPopup(`
                    <div class="asset-popup">
                        <div class="asset-popup-title">${name}</div>
                        <div class="asset-popup-subtitle">TCN TRANSMISSION STATION</div>
                        <div class="asset-popup-divider"></div>
                        <div class="asset-popup-grid">
                            <div class="asset-popup-label">Asset Type</div>
                            <div class="asset-popup-value">132/33 kV TS</div>
                            <div class="asset-popup-label">Operator</div>
                            <div class="asset-popup-value">TCN</div>
                            <div class="asset-popup-label">Coordinates</div>
                            <div class="asset-popup-value">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
                        </div>
                    </div>
                `, { className: 'asset-popup-wrapper', maxWidth: 300, minWidth: 240 });
                tcnLayer.addLayer(marker);
            });

            // Cached fallback for the empty-filter case (first render uses data bounds).
            utBoundsCache = utGeo.getBounds();
            boundariesLoaded = true;
        } catch (err) {
            console.error('Failed to load boundary GeoJSON:', err);
        }
    }

    function updateKeyInsights() {
        const container = document.getElementById('keyInsightsContent');
        if (!container) return;
        const data = filteredData;
        const total = data.length;
        if (total === 0) { container.innerHTML = '<p style="color:var(--text-secondary);">No data to display.</p>'; return; }

        // --- Velocity ---
        const dateStrings = data.map(d => d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '').filter(Boolean);
        const dates = [...new Set(dateStrings)].sort();
        const activeDays = dates.length || 1;
        const runRate = (total / activeDays).toFixed(1);

        // Recent trend (last 3 days vs prior 3)
        const recent3 = dates.slice(-3);
        const prev3 = dates.slice(-6, -3);
        const recentCount = data.filter(d => { const ds = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : ''; return recent3.includes(ds); }).length;
        const prevCount = data.filter(d => { const ds = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : ''; return prev3.includes(ds); }).length;
        const recentRate = recent3.length > 0 ? Math.round(recentCount / recent3.length) : 0;
        const prevRate = prev3.length > 0 ? Math.round(prevCount / prev3.length) : 0;
        const trendPct = prevRate > 0 ? Math.round(((recentRate - prevRate) / prevRate) * 100) : 0;
        const trendIcon = trendPct > 5 ? '▲' : trendPct < -5 ? '▼' : '►';
        const trendColor = trendPct > 5 ? '#10b981' : trendPct < -5 ? '#ef4444' : '#eab308';

        // --- Vendor race ---
        const vendorCounts = {};
        data.forEach(d => { vendorCounts[d.Vendor_Name || 'Other'] = (vendorCounts[d.Vendor_Name || 'Other'] || 0) + 1; });
        const sortedVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);
        const vendorColors = { 'ETC Workforce': '#0EA5E9', 'Jesom Technology': '#f97316', 'Ikeja Electric': '#eab308' };

        // --- Officers ---
        const userCounts = {};
        data.forEach(d => { if (d.User) userCounts[d.User] = (userCounts[d.User] || 0) + 1; });
        const totalUsers = Object.keys(userCounts).length;

        // --- Defects ---
        const defects = data.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
        const defectPct = ((defects / total) * 100).toFixed(1);
        const healthPct = (100 - parseFloat(defectPct)).toFixed(1);

        // --- Coverage ---
        const feederCount = new Set(data.map(d => d.Feeder).filter(Boolean)).size;
        const dtCount = new Set(data.map(d => d["DT Name"]).filter(Boolean)).size;
        const utCount = new Set(data.map(d => d.Undertaking).filter(Boolean)).size;

        // --- BOQ completion ---
        const boqTotal = boqData.length > 0 ? boqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0) : 0;
        const completionPct = boqTotal > 0 ? Math.min(((total / boqTotal) * 100), 100).toFixed(1) : null;

        // --- Pole types ---
        const poleTypes = {};
        data.forEach(d => { const t = (d["Type of Pole"] || 'Unknown').toUpperCase(); poleTypes[t] = (poleTypes[t] || 0) + 1; });
        const sortedPoles = Object.entries(poleTypes).sort((a, b) => b[1] - a[1]);

        // --- Date range ---
        const firstDate = dates[0] || 'N/A';
        const lastDate = dates[dates.length - 1] || 'N/A';

        // Mini bar helper
        const miniBar = (pct, color) => `<div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;margin-top:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width 0.5s;"></div></div>`;

        // Vendor race bars
        const vendorBarsHTML = sortedVendors.map(([name, count]) => {
            const pct = ((count / total) * 100).toFixed(0);
            const color = vendorColors[name] || '#a0a0a0';
            return `<div style="margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;font-size:0.8rem;">
                    <span style="color:${color};font-weight:600;">${name}</span>
                    <span style="color:var(--text-secondary);">${count.toLocaleString()} (${pct}%)</span>
                </div>
                ${miniBar(pct, color)}
            </div>`;
        }).join('');

        // Pole type bars
        const poleTypeBarsHTML = sortedPoles.slice(0, 3).map(([type, count]) => {
            const pct = ((count / total) * 100).toFixed(0);
            const color = type.includes('CONCRETE') ? '#10b981' : type.includes('WOOD') ? '#ef4444' : '#6b7280';
            return `<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:3px;">
                <span style="color:${color};">${type}</span>
                <span style="color:var(--text-secondary);">${pct}%</span>
            </div>`;
        }).join('');

        container.innerHTML = `
            <!-- Velocity & Trend -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="insight-label">Project Velocity</span>
                    <span style="font-size:0.8rem;color:${trendColor};font-weight:600;">${trendIcon} ${trendPct > 0 ? '+' : ''}${trendPct}% vs prior</span>
                </div>
                <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
                    <span style="font-size:1.6rem;font-weight:800;color:hsl(var(--foreground));">${runRate}</span>
                    <span style="font-size:0.85rem;color:var(--text-secondary);">poles/day avg</span>
                </div>
                <div style="display:flex;gap:12px;font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
                    <span>${total.toLocaleString()} poles</span>
                    <span>${activeDays} active days</span>
                    <span>${totalUsers} officers</span>
                </div>
            </div>

            ${completionPct !== null ? `
            <!-- BOQ Completion -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="insight-label">BOQ Completion</span>
                    <span style="font-size:1.1rem;font-weight:700;color:${parseFloat(completionPct) >= 50 ? '#10b981' : '#eab308'};">${completionPct}%</span>
                </div>
                ${miniBar(completionPct, parseFloat(completionPct) >= 50 ? '#10b981' : '#eab308')}
                <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:4px;">${total.toLocaleString()} of ${boqTotal.toLocaleString()} target poles</div>
            </div>
            ` : ''}

            <!-- Vendor Race -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <span class="insight-label" style="margin-bottom:8px;">Vendor Leaderboard</span>
                ${vendorBarsHTML}
            </div>

            <!-- Per-Vendor Officer Performance -->
            ${(() => {
                const vendorNames = ['ETC Workforce', 'Jesom Technology', 'Ikeja Electric'];
                const vColors = { 'ETC Workforce': '#0EA5E9', 'Jesom Technology': '#f97316', 'Ikeja Electric': '#eab308' };
                const vShort = { 'ETC Workforce': 'ETC', 'Jesom Technology': 'Jesom', 'Ikeja Electric': 'Ikeja' };
                const rows = vendorNames.map(v => {
                    const vUsers = {};
                    data.filter(d => d.Vendor_Name === v).forEach(d => { if (d.User) vUsers[d.User] = (vUsers[d.User] || 0) + 1; });
                    const sorted = Object.entries(vUsers).sort((a, b) => b[1] - a[1]);
                    if (sorted.length === 0) return '';
                    const best = sorted[0];
                    const worst = sorted[sorted.length - 1];
                    const color = vColors[v];
                    return `<div style="margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.02);border-radius:6px;border-left:3px solid ${color};">
                        <div style="font-size:0.75rem;font-weight:700;color:${color};margin-bottom:5px;">${vShort[v]} (${sorted.length} officers)</div>
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <div style="font-size:0.65rem;color:#10b981;font-weight:600;">BEST</div>
                                <div style="font-weight:700;font-size:0.85rem;color:hsl(var(--foreground));">${getDisplayName(best[0])}</div>
                                <div style="font-size:0.75rem;color:var(--text-secondary);">${best[1]} poles</div>
                            </div>
                            <div style="text-align:center;padding:0 6px;">
                                <div style="font-size:0.95rem;font-weight:800;color:${color};">${worst[1] > 0 ? (best[1] / worst[1]).toFixed(1) : '∞'}x</div>
                                <div style="font-size:0.6rem;color:var(--text-secondary);">gap</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.65rem;color:#ef4444;font-weight:600;">LOWEST</div>
                                <div style="font-weight:700;font-size:0.85rem;color:hsl(var(--foreground));">${getDisplayName(worst[0])}</div>
                                <div style="font-size:0.75rem;color:var(--text-secondary);">${worst[1]} poles</div>
                            </div>
                        </div>
                    </div>`;
                }).filter(Boolean).join('');
                return rows ? `<div class="insight-item" style="flex-direction:column;align-items:stretch;">
                    <span class="insight-label" style="margin-bottom:6px;">Officer Performance by Vendor</span>
                    ${rows}
                </div>` : '';
            })()}

            <!-- Asset Health -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="insight-label">Asset Health</span>
                    <span style="font-size:0.85rem;font-weight:600;color:${parseFloat(defectPct) > 25 ? '#ef4444' : '#10b981'};">${healthPct}% Good</span>
                </div>
                <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;">
                    <div style="width:${healthPct}%;background:#10b981;"></div>
                    <div style="width:${defectPct}%;background:#ef4444;"></div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-top:3px;">
                    <span style="color:#10b981;">${(total - defects).toLocaleString()} good</span>
                    <span style="color:#ef4444;">${defects.toLocaleString()} defects (${defectPct}%)</span>
                </div>
            </div>

            <!-- Network Coverage -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <span class="insight-label" style="margin-bottom:6px;">Network Coverage</span>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;">
                    <div style="background:rgba(255,255,255,0.03);border-radius:6px;padding:8px 4px;">
                        <div style="font-size:1.2rem;font-weight:800;color:hsl(var(--foreground));">${feederCount}</div>
                        <div style="font-size:0.7rem;color:var(--text-secondary);">Feeders</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border-radius:6px;padding:8px 4px;">
                        <div style="font-size:1.2rem;font-weight:800;color:hsl(var(--foreground));">${dtCount}</div>
                        <div style="font-size:0.7rem;color:var(--text-secondary);">DTs</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border-radius:6px;padding:8px 4px;">
                        <div style="font-size:1.2rem;font-weight:800;color:hsl(var(--foreground));">${utCount}</div>
                        <div style="font-size:0.7rem;color:var(--text-secondary);">Undertakings</div>
                    </div>
                </div>
            </div>

            <!-- Pole Material Mix -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <span class="insight-label" style="margin-bottom:6px;">Pole Material Mix</span>
                ${poleTypeBarsHTML}
            </div>

            <!-- Data Window -->
            <div class="insight-item">
                <span class="insight-label">Data Window</span>
                <span style="font-size:0.85rem;color:var(--text-secondary);text-align:right;">${firstDate}<br>${lastDate}</span>
            </div>
        `;
    }

    // Navigation Logic
    const navHome = document.getElementById('nav-home');
    const navDashboard = document.getElementById('nav-dashboard');
    const viewHome = document.getElementById('view-home');
    const viewDashboard = document.getElementById('view-dashboard');
    const dashboardSubLinks = document.getElementById('dashboard-sub-links');

    if (navHome && navDashboard) {
        navHome.addEventListener('click', (e) => {
            e.preventDefault();
            viewHome.classList.remove('hidden');
            viewDashboard.classList.add('hidden');
            navHome.classList.add('active');
            navDashboard.classList.remove('active');
            if (dashboardSubLinks) dashboardSubLinks.classList.add('hidden');
        });

        navDashboard.addEventListener('click', (e) => {
            e.preventDefault();
            viewHome.classList.add('hidden');
            viewDashboard.classList.remove('hidden');
            navHome.classList.remove('active');
            navDashboard.classList.add('active');
            if (dashboardSubLinks) dashboardSubLinks.classList.remove('hidden');

            // Trigger chart resize in case they were hidden
            window.dispatchEvent(new Event('resize'));
        });
    }


    // --- VARIANCE LOGIC & HELPERS ---



    function handleViewModeToggle(e) {
        viewMode = e.target.checked ? 'boq' : 'field';
        updateDashboard();
    }

    // Merge Function
    function calculateVariance() {
        // 1. Group Field Data by Feeder + DT
        // Key: "Feeder|DT Name"
        const fieldGroups = {};

        filteredData.forEach(d => {
            const feeder = (d.Feeder || "").trim().toUpperCase();
            const dt = (d["DT Name"] || "").trim().toUpperCase();
            const key = `${feeder}|${dt}`;

            if (!fieldGroups[key]) {
                fieldGroups[key] = {
                    feeder: d.Feeder,
                    dtName: d["DT Name"],
                    vendor: d.Vendor_Name,
                    actualTotal: 0,
                    actualGood: 0,
                    actualBad: 0,
                    users: new Set()
                };
            }
            fieldGroups[key].actualTotal++;
            if (d.Issue_Type === 'Good Condition') fieldGroups[key].actualGood++;
            else fieldGroups[key].actualBad++;
            fieldGroups[key].users.add(d.User);
        });

        // 2. Iterate BOQ and Merge
        // Apply Filters to BOQ Data as well (Feeder and DT only)
        const feederVals = multiSelects.feederFilter?.getValues();
        const dtVals = multiSelects.dtFilter?.getValues();

        const filteredBOQ = boqData.filter(boq => {
            if (feederVals && !feederVals.includes(boq["FEEDER NAME"])) return false;
            if (dtVals && !dtVals.includes(boq["DT NAME"])) return false;
            return true;
        });

        const merged = filteredBOQ.map(boq => {
            const feeder = (boq["FEEDER NAME"] || "").trim().toUpperCase();
            const dt = (boq["DT NAME"] || "").trim().toUpperCase();
            const key = `${feeder}|${dt}`;

            const field = fieldGroups[key] || { actualTotal: 0, actualGood: 0, actualBad: 0, users: new Set(), vendor: 'N/A' };

            const boqTotal = parseInt(boq["POLES Grand Total"]) || 0;
            const boqGood = parseInt(boq["GOOD"]) || 0;
            const boqBad = parseInt(boq["BAD"]) || 0;

            const variance = boqTotal > 0 ? ((field.actualTotal - boqTotal) / boqTotal * 100) : 0; // % Diff? Or just use raw diff?
            // User requested: "Variance (%)"
            // Formula: (Actual - BOQ) / BOQ * 100 usually. 
            // If Actual < BOQ, negative %. If Actual > BOQ, positive %.

            return {
                feeder: boq["FEEDER NAME"],
                dtName: boq["DT NAME"],
                vendor: field.vendor === 'N/A' ? 'Not Started' : field.vendor,
                boqTotal: boqTotal,
                actualTotal: field.actualTotal,
                boqGood,
                actualGood: field.actualGood,
                boqBad,
                actualBad: field.actualBad,
                variance: variance,
                users: Array.from(field.users)
            };
        });

        // Also include Field items that were NOT in BOQ? (New discoveries)
        // User didn't strictly ask, but good practice.
        // For simplicity, sticking to BOQ base as "Baseline BOQ" implies.

        return merged;
    }

    function renderVarianceCharts() {
        const mergedData = calculateVariance();

        // Chart 1: Target vs Actual (Bulleted Progres) - Top 10 Feeders or Global? 
        // User: "Feeders & DTs". Let's do Top 10 Feeders by Volume
        const feederStats = {};
        mergedData.forEach(d => {
            const f = d.feeder || "Unknown";
            if (!feederStats[f]) feederStats[f] = { boq: 0, act: 0 };
            feederStats[f].boq += d.boqTotal;
            feederStats[f].act += d.actualTotal;
        });

        const sortedFeeders = Object.entries(feederStats)
            .sort((a, b) => b[1].boq - a[1].boq)
            .slice(0, 10);

        const feederLabels = sortedFeeders.map(x => x[0]);
        const feederBoq = sortedFeeders.map(x => x[1].boq);
        const feederAct = sortedFeeders.map(x => x[1].act);

        // ApexChart Options for Target vs Actual
        const options1 = {
            series: [
                { name: 'Actual Captured', data: feederAct },
                { name: 'Total Target', data: feederBoq }
            ],
            chart: { type: 'bar', height: 400, toolbar: { show: false }, background: 'transparent' },
            plotOptions: {
                bar: {
                    horizontal: true,
                    dataLabels: { position: 'top' },
                }
            },
            colors: ['#10b981', 'rgba(16, 185, 129, 0.3)'], // Solid Green, Transparent Green
            dataLabels: {
                enabled: true,
                offsetX: -6,
                style: { fontSize: '12px', colors: ['#fff'] }
            },
            stroke: { show: true, width: 1, colors: ['#fff'] },
            xaxis: { title: { text: 'Number of Poles', style: { color: '#a0a0a0' } }, labels: { style: { colors: '#a0a0a0' } } },
            yaxis: { labels: { style: { colors: '#fff' } } },
            theme: { mode: 'dark' },
            grid: { borderColor: '#373a40' }
        };

        const chart1El = document.querySelector("#targetActualChart");
        chart1El.innerHTML = ""; // Clear
        const chart1 = new ApexCharts(chart1El, options1);
        chart1.render();

        // Chart 2: Pole Health Reconciliation (Grouped Bar) - Top 10 DTs
        const topDTs = mergedData
            .sort((a, b) => b.boqTotal - a.boqTotal)
            .slice(0, 10);

        const dtLabels = topDTs.map(d => d.dtName);

        const options2 = {
            series: [
                { name: 'Total Bad', data: topDTs.map(d => d.boqBad) },
                { name: 'Actual Bad', data: topDTs.map(d => d.actualBad) },
                { name: 'Total Good', data: topDTs.map(d => d.boqGood) },
                { name: 'Actual Good', data: topDTs.map(d => d.actualGood) }
            ],
            chart: { type: 'bar', height: 400, toolbar: { show: false }, background: 'transparent' },
            colors: ['rgba(239, 68, 68, 0.4)', '#ef4444', 'rgba(16, 185, 129, 0.4)', '#10b981'], // Transp Red, Solid Red, Transp Green, Solid Green
            plotOptions: {
                bar: { horizontal: false, columnWidth: '55%', endingShape: 'rounded' }
            },
            dataLabels: { enabled: false },
            xaxis: { categories: dtLabels, labels: { style: { colors: '#a0a0a0' } } },
            yaxis: { title: { text: 'Count', style: { color: '#a0a0a0' } }, labels: { style: { colors: '#a0a0a0' } } },
            theme: { mode: 'dark' },
            grid: { borderColor: '#373a40' },
            legend: { labels: { colors: '#fff' } }
        };

        const chart2El = document.querySelector("#poleHealthChart");
        chart2El.innerHTML = "";
        const chart2 = new ApexCharts(chart2El, options2);
        chart2.render();
    }


    // 8. Render Strategic Recommendations (Dynamic)
    function renderStrategicRecommendations() {
        const vendors = ['ETC Workforce', 'Jesom Technology', 'Ikeja Electric'];
        const TARGET_RATE = 50;

        // Use filteredData so cards react to filter changes; globalData as benchmark
        const activeData = filteredData.length > 0 ? filteredData : globalData;
        const globalTotal = activeData.length;
        const globalDefects = activeData.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
        const globalDefectPct = globalTotal > 0 ? ((globalDefects / globalTotal) * 100) : 0;

        // BOQ target for completion context
        const boqTotal = boqData.length > 0
            ? boqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0)
            : 0;

        vendors.forEach(vendor => {
            const vData = activeData.filter(d => d.Vendor_Name === vendor);
            const idKey = vendor.split(' ')[0].toLowerCase();
            const badge = document.getElementById(`status-badge-${idKey}`);
            const content = document.getElementById(`rec-content-${idKey}`);

            if (vData.length === 0) {
                if (badge) { badge.textContent = 'Pending Data'; badge.className = 'status-badge status-attention'; }
                if (content) { content.innerHTML = '<div class="rec-item"><p>Awaiting field captures from this vendor.</p></div>'; }
                return;
            }

            // --- Deep Metrics ---
            const totalRecords = vData.length;
            const shareOfTotal = ((totalRecords / globalTotal) * 100).toFixed(1);

            // Dates & velocity
            const dateStrings = vData.map(d => d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '').filter(Boolean);
            const dates = new Set(dateStrings);
            const activeDays = dates.size || 1;
            const avgRate = Math.round(totalRecords / activeDays);
            const sortedDates = Array.from(dates).sort();
            const lastDateISO = sortedDates[sortedDates.length - 1];
            const firstDateISO = sortedDates[0];

            // Recent trend: last 5 active days vs previous 5
            const recentDays = sortedDates.slice(-5);
            const prevDays = sortedDates.slice(-10, -5);
            const recentCount = vData.filter(d => { const ds = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : ''; return recentDays.includes(ds); }).length;
            const prevCount = vData.filter(d => { const ds = d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : ''; return prevDays.includes(ds); }).length;
            const recentRate = recentDays.length > 0 ? Math.round(recentCount / recentDays.length) : 0;
            const prevRate = prevDays.length > 0 ? Math.round(prevCount / prevDays.length) : 0;
            const trendDir = recentRate > prevRate ? 'accelerating' : recentRate < prevRate ? 'decelerating' : 'steady';
            const trendDelta = prevRate > 0 ? Math.abs(Math.round(((recentRate - prevRate) / prevRate) * 100)) : 0;

            // Users
            const userCounts = {};
            vData.forEach(d => { if (d.User) userCounts[d.User] = (userCounts[d.User] || 0) + 1; });
            const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
            const totalUsers = sortedUsers.length;
            const topUser = sortedUsers[0];
            const bottomUser = sortedUsers[sortedUsers.length - 1];
            const topUserName = topUser ? getDisplayName(topUser[0]) : 'N/A';
            const bottomUserName = bottomUser ? getDisplayName(bottomUser[0]) : 'N/A';
            const avgPerUser = totalUsers > 0 ? Math.round(totalRecords / totalUsers) : 0;

            // Top user contribution %
            const topUserPct = topUser ? ((topUser[1] / totalRecords) * 100).toFixed(1) : 0;

            // Undertakings & concentration
            const utCounts = {};
            vData.forEach(d => { if (d.Undertaking) utCounts[d.Undertaking] = (utCounts[d.Undertaking] || 0) + 1; });
            const sortedUTs = Object.entries(utCounts).sort((a, b) => b[1] - a[1]);
            const activeUTs = sortedUTs.length;
            const topUT = sortedUTs[0];
            const bottomUT = sortedUTs[sortedUTs.length - 1];
            const topUtPct = topUT ? ((topUT[1] / totalRecords) * 100).toFixed(0) : 0;

            // DTs
            const dtCount = new Set(vData.map(d => d["DT Name"])).size;
            const feederCount = new Set(vData.map(d => d.Feeder)).size;

            // Defect analysis
            const badPoles = vData.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
            const defectPct = ((badPoles / totalRecords) * 100).toFixed(1);
            const defectDiff = (parseFloat(defectPct) - globalDefectPct).toFixed(1);
            const defectAboveAvg = parseFloat(defectDiff) > 0;

            // Pole types
            const poleTypes = {};
            vData.forEach(d => { const t = (d["Type of Pole"] || 'Unknown').toUpperCase(); poleTypes[t] = (poleTypes[t] || 0) + 1; });
            const concreteCount = Object.entries(poleTypes).filter(([k]) => k.includes('CONCRETE')).reduce((s, [, v]) => s + v, 0);
            const woodCount = Object.entries(poleTypes).filter(([k]) => k.includes('WOOD')).reduce((s, [, v]) => s + v, 0);
            const concretePct = totalRecords > 0 ? ((concreteCount / totalRecords) * 100).toFixed(0) : 0;
            const woodPct = totalRecords > 0 ? ((woodCount / totalRecords) * 100).toFixed(0) : 0;

            // Data freshness
            const lastDateObj = lastDateISO ? new Date(lastDateISO) : new Date();
            const diffDays = Math.ceil(Math.abs(new Date() - lastDateObj) / (1000 * 60 * 60 * 24));

            // Completion vs BOQ
            const completionPct = boqTotal > 0 ? ((totalRecords / boqTotal) * 100).toFixed(1) : null;

            // --- STATUS DETERMINATION (multi-factor) ---
            let statusScore = 0;
            if (avgRate >= TARGET_RATE) statusScore += 2;
            else if (avgRate >= 35) statusScore += 1;
            if (parseFloat(defectPct) <= globalDefectPct) statusScore += 1;
            if (trendDir === 'accelerating') statusScore += 1;
            if (activeUTs >= 4) statusScore += 1;
            if (diffDays <= 2) statusScore += 1;

            let status, statusClass;
            if (statusScore >= 5) { status = 'Excelling'; statusClass = 'status-good'; }
            else if (statusScore >= 3) { status = 'On Track'; statusClass = 'status-good'; }
            else { status = 'Requires Attention'; statusClass = 'status-attention'; }

            // --- BUILD 5 DEEP RECOMMENDATIONS ---
            const recs = [];

            // 1. Velocity & Trend
            const trendEmoji = trendDir === 'accelerating' ? '📈' : trendDir === 'decelerating' ? '📉' : '➡️';
            if (avgRate < 30) {
                recs.push({
                    icon: '🚨', title: 'Critical: Deployment Velocity',
                    text: `Averaging only <strong>${avgRate} poles/day</strong> across ${activeDays} active days — well below the ${TARGET_RATE}/day target. ` +
                        `Recent trend is <strong>${trendDir}</strong> ${trendDelta > 0 ? `(${trendDir === 'decelerating' ? '-' : '+'}${trendDelta}%)` : ''}. ` +
                        `With ${totalUsers} officers, each averages ${avgPerUser} poles. Scaling up to ${Math.ceil(TARGET_RATE / Math.max(avgPerUser, 1))} officers or increasing individual output to ${Math.ceil(TARGET_RATE / Math.max(totalUsers, 1))}/day per officer is needed.`
                });
            } else if (avgRate < TARGET_RATE) {
                recs.push({
                    icon: '⚠️', title: 'Velocity Gap Analysis',
                    text: `Running at <strong>${avgRate} poles/day</strong> (${Math.round((avgRate / TARGET_RATE) * 100)}% of target). ` +
                        `Trend is <strong>${trendDir}</strong> ${trendEmoji} — recent 5-day avg: ${recentRate}/day vs prior: ${prevRate}/day${trendDelta > 0 ? ` (${trendDir === 'decelerating' ? '-' : '+'}${trendDelta}% shift)` : ''}. ` +
                        `Gap of <strong>${TARGET_RATE - avgRate} poles/day</strong> to close. ${totalUsers} officers need to add ~${Math.ceil((TARGET_RATE - avgRate) / Math.max(totalUsers, 1))} extra poles/day each.`
                });
            } else {
                recs.push({
                    icon: '⭐', title: 'Strong Velocity Performance',
                    text: `Delivering <strong>${avgRate} poles/day</strong> — exceeding the ${TARGET_RATE}/day target by ${avgRate - TARGET_RATE}. ` +
                        `Trend is <strong>${trendDir}</strong> ${trendEmoji} (recent: ${recentRate}/day vs prior: ${prevRate}/day). ` +
                        `${totalRecords.toLocaleString()} total poles captured across ${activeDays} active days with ${totalUsers} officers averaging ${avgPerUser} poles each.`
                });
            }

            // 2. Workforce Performance
            if (totalUsers >= 2) {
                const performanceGap = topUser[1] - bottomUser[1];
                const gapMultiple = bottomUser[1] > 0 ? (topUser[1] / bottomUser[1]).toFixed(1) : '∞';
                recs.push({
                    icon: '👥', title: 'Workforce Performance',
                    text: `<strong>${totalUsers} officers</strong> active (avg: ${avgPerUser} poles each). ` +
                        `Top performer: <strong>${topUserName}</strong> with ${topUser[1].toLocaleString()} poles (${topUserPct}% of team output). ` +
                        `Lowest: <strong>${bottomUserName}</strong> with ${bottomUser[1].toLocaleString()} poles — a <strong>${gapMultiple}x gap</strong>. ` +
                        `${performanceGap > avgPerUser * 2 ? 'Significant disparity exists — consider pairing low performers with high performers for mentoring.' : 'Reasonable output distribution across the team.'}`
                });
            } else {
                recs.push({
                    icon: '👤', title: 'Single Operator',
                    text: `Only <strong>1 officer</strong> (${topUserName}) is active with ${totalRecords.toLocaleString()} poles. This is a single-point-of-failure risk. ` +
                        `If this officer becomes unavailable, vendor output drops to zero. Consider deploying additional staff.`
                });
            }

            // 3. Coverage & Geographic Spread
            const topUtName = topUT ? topUT[0] : 'N/A';
            if (activeUTs < 3 && totalRecords > 50) {
                recs.push({
                    icon: '📍', title: 'Coverage Concentration Risk',
                    text: `Work is concentrated in only <strong>${activeUTs} Undertaking${activeUTs > 1 ? 's' : ''}</strong> covering ${feederCount} feeders and ${dtCount} DTs. ` +
                        `<strong>${topUtName}</strong> accounts for ${topUtPct}% of all activity. ` +
                        `This creates blind spots in the network. Redistribute teams to unserved undertakings for broader asset visibility.`
                });
            } else {
                const spread = sortedUTs.slice(0, 3).map(([name, count]) => `${name} (${count})`).join(', ');
                recs.push({
                    icon: '🗺️', title: 'Network Coverage',
                    text: `Spanning <strong>${activeUTs} Undertakings</strong>, ${feederCount} feeders, and ${dtCount} DTs. ` +
                        `Heaviest activity: ${spread}. ` +
                        `${bottomUT && bottomUT[1] < avgPerUser ? `<strong>${bottomUT[0]}</strong> has only ${bottomUT[1]} poles — consider allocating more resources there.` : 'Coverage is reasonably balanced across areas.'}`
                });
            }

            // 4. Quality & Defect Intelligence
            const defectCompare = defectAboveAvg
                ? `<strong>${Math.abs(parseFloat(defectDiff))}% above</strong> the project average of ${globalDefectPct.toFixed(1)}%`
                : `<strong>${Math.abs(parseFloat(defectDiff))}% below</strong> the project average of ${globalDefectPct.toFixed(1)}%`;
            if (parseFloat(defectPct) > 25) {
                recs.push({
                    icon: '🔍', title: 'High Defect Rate — Investigation Needed',
                    text: `<strong>${defectPct}% defect rate</strong> (${badPoles.toLocaleString()} of ${totalRecords.toLocaleString()} poles flagged) — ${defectCompare}. ` +
                        `Pole mix: ${concretePct}% concrete, ${woodPct}% wood. ` +
                        `${parseFloat(woodPct) > 40 ? 'High proportion of wooden poles may explain elevated defects — wooden poles degrade faster.' : ''} ` +
                        `Recommend field verification audits to confirm defect accuracy and prioritize replacement scheduling.`
                });
            } else if (parseFloat(defectPct) < 5) {
                recs.push({
                    icon: '🎯', title: 'Low Defect Rate — Verify Accuracy',
                    text: `Only <strong>${defectPct}% defect rate</strong> (${badPoles} flagged) — ${defectCompare}. ` +
                        `Pole mix: ${concretePct}% concrete, ${woodPct}% wood. ` +
                        `Unusually low defect reporting may indicate under-detection. Conduct random spot-check audits on ${Math.min(20, Math.ceil(totalRecords * 0.05))} poles to validate.`
                });
            } else {
                recs.push({
                    icon: '📊', title: 'Defect & Asset Quality',
                    text: `<strong>${defectPct}% defect rate</strong> (${badPoles.toLocaleString()} of ${totalRecords.toLocaleString()}) — ${defectCompare}. ` +
                        `Pole mix: ${concretePct}% concrete, ${woodPct}% wood. ` +
                        `${defectAboveAvg ? 'Slightly above project norm — monitor for trending upward and investigate concentrated areas.' : 'Within acceptable range. Maintain current inspection standards.'}`
                });
            }

            // 5. Data Freshness & Completion
            if (diffDays > 5) {
                recs.push({
                    icon: '🔄', title: 'Stale Data — Sync Required',
                    text: `Last activity recorded on <strong>${lastDateISO}</strong> — <strong>${diffDays} days ago</strong>. ` +
                        `${totalRecords.toLocaleString()} poles captured from ${firstDateISO} to ${lastDateISO}. ` +
                        `${completionPct ? `Contributing ${shareOfTotal}% of total project data (${completionPct}% of BOQ target). ` : `Contributing ${shareOfTotal}% of total project data. `}` +
                        `Enforce daily sync protocol — data older than 48 hours reduces dashboard reliability for planning.`
                });
            } else {
                recs.push({
                    icon: '✅', title: 'Project Contribution & Progress',
                    text: `<strong>${totalRecords.toLocaleString()} poles</strong> captured (${shareOfTotal}% of project total) from ${firstDateISO} to ${lastDateISO}. ` +
                        `${completionPct ? `This represents <strong>${completionPct}%</strong> towards the BOQ target of ${boqTotal.toLocaleString()} poles. ` : ''}` +
                        `Data is fresh (last sync: ${diffDays === 0 ? 'today' : diffDays === 1 ? 'yesterday' : diffDays + ' days ago'}). ` +
                        `${parseFloat(completionPct) < 50 ? 'Significant ground still to cover — maintain or increase current pace.' : parseFloat(completionPct) < 80 ? 'Good progress — entering the final stretch.' : 'Nearing completion — focus on quality verification of remaining assets.'}`
                });
            }

            // --- RENDER ---
            if (badge) {
                badge.textContent = status;
                badge.className = `status-badge ${statusClass}`;
            }

            if (content) {
                content.innerHTML = recs.map(r => `
                    <div class="rec-item">
                        <h4>${r.icon} ${r.title}</h4>
                        <p>${r.text}</p>
                    </div>
                `).join('');
            }
        });
    }

    // --- Event Listeners ---
    const resetFiltersBtn = document.getElementById('resetFiltersBtn');
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', resetFilters);
    }




    // --- Search Intelligence ---
    let searchFocusIndex = -1;

    function highlightMatch(text, query) {
        if (!query) return text;
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return text;
        return text.slice(0, idx) + '<mark>' + text.slice(idx, idx + query.length) + '</mark>' + text.slice(idx + query.length);
    }

    function handleSearchInput(val) {
        const list = document.getElementById('searchSuggestions');
        if (!list) return;

        const query = val.trim();
        if (query.length === 0) {
            list.style.display = 'none';
            searchFocusIndex = -1;
            return;
        }

        const suggestions = getSearchSuggestions(query);
        if (suggestions.length === 0) {
            list.style.display = 'none';
            return;
        }

        // Clear old items but keep the header
        list.innerHTML = '<div class="search-suggestions-header">Suggestions</div>';
        searchFocusIndex = -1;

        suggestions.forEach((item, i) => {
            const div = document.createElement('div');
            div.className = 'search-suggestion-item';
            div.setAttribute('data-index', i);

            const typeClass = `type-${item.type.toLowerCase()}`;
            div.innerHTML = `
                <span class="suggestion-label">${highlightMatch(item.text, query)}</span>
                <span class="suggestion-type ${typeClass}">${item.type}</span>
            `;

            div.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent blur before click
                applySearchSuggestion(item.text);
            });

            list.appendChild(div);
        });

        list.style.display = 'flex';
    }

    // Keyboard navigation for intellisense
    const dtSearchInput = document.getElementById('dtSearchInput');
    if (dtSearchInput) {
        dtSearchInput.addEventListener('keydown', function (e) {
            const list = document.getElementById('searchSuggestions');
            if (!list || list.style.display === 'none') return;

            const items = list.querySelectorAll('.search-suggestion-item');
            if (!items.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                searchFocusIndex = Math.min(searchFocusIndex + 1, items.length - 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                searchFocusIndex = Math.max(searchFocusIndex - 1, 0);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (searchFocusIndex >= 0 && items[searchFocusIndex]) {
                    items[searchFocusIndex].dispatchEvent(new MouseEvent('mousedown'));
                }
                return;
            } else if (e.key === 'Escape') {
                list.style.display = 'none';
                searchFocusIndex = -1;
                return;
            } else {
                return;
            }

            items.forEach((el, i) => {
                el.classList.toggle('focused', i === searchFocusIndex);
            });
        });

        dtSearchInput.addEventListener('input', function () {
            currentPage = 1;
            renderDTTable();
            handleSearchInput(this.value);
        });

        dtSearchInput.addEventListener('blur', () => {
            setTimeout(() => {
                const list = document.getElementById('searchSuggestions');
                if (list) list.style.display = 'none';
            }, 200);
        });

        dtSearchInput.addEventListener('focus', function () {
            if (this.value.trim().length > 0) handleSearchInput(this.value);
        });
    }

    function getSearchSuggestions(query) {
        const maxResults = 10;
        const results = [];
        const seen = new Set();
        const q = query.toLowerCase();

        const add = (text, type) => {
            if (results.length >= maxResults) return;
            const t = String(text || '');
            if (t && t.toLowerCase().includes(q) && !seen.has(t)) {
                seen.add(t);
                results.push({ text: t, type });
            }
        };

        // Search from enhanced DT data for richer coverage
        const dtData = getEnhancedDTData();
        for (const row of dtData) {
            if (results.length >= maxResults) break;
            add(row.dtName, 'DT');
            add(row.feeder, 'Feeder');
            add(row.vendor !== 'Pending' ? row.vendor : null, 'Vendor');
            add(row.bu !== '-' ? row.bu : null, 'BU');
            add(row.undertaking !== '-' ? row.undertaking : null, 'BU');
            if (row.users) row.users.forEach(u => add(getDisplayName(u) || u, 'User'));
        }

        return results;
    }

    function applySearchSuggestion(text) {
        const input = document.getElementById('dtSearchInput');
        if (input) {
            input.value = text;
            input.dispatchEvent(new Event('input'));
            const list = document.getElementById('searchSuggestions');
            if (list) list.style.display = 'none';
        }
    }

    // --- Column Visibility Logic ---
    const columnConfig = [
        { id: 'col-index', label: '#', checked: true },
        { id: 'col-dtName', label: 'DT Name', checked: true },
        { id: 'col-feeder', label: 'Feeder', checked: true },
        { id: 'col-bu', label: 'BU', checked: true },
        { id: 'col-undertaking', label: 'Undertaking', checked: true },
        { id: 'col-vendor', label: 'Vendor', checked: true },
        { id: 'col-users', label: 'Field Officers', checked: true },
        { id: 'col-boqTotal', label: 'Ex. Poles', checked: true },
        { id: 'col-newPoles', label: 'New Poles (Install)', checked: true },
        { id: 'col-actualTotal', label: 'Actual', checked: true },
        { id: 'col-remaining', label: 'Remaining', checked: true },
        { id: 'col-concrete', label: 'Concrete', checked: true },
        { id: 'col-wooden', label: 'Wooden', checked: true },
        { id: 'col-progress', label: 'Progress', checked: true },
        { id: 'col-status', label: 'Status', checked: true }
    ];

    function initColumnFilter() {
        const btn = document.getElementById('columnFilterBtn');
        const menu = document.getElementById('columnFilterMenu');
        if (!btn || !menu) return;

        // Toggle Menu
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) {
                menu.style.display = 'none';
            }
        });

        // Populate Menu
        menu.innerHTML = '';
        columnConfig.forEach(col => {
            const item = document.createElement('label');
            item.className = 'col-check-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = col.checked;
            cb.dataset.colId = col.id;

            cb.addEventListener('change', () => {
                col.checked = cb.checked;
                updateColumnVisibility();
            });

            item.appendChild(cb);
            item.appendChild(document.createTextNode(col.label));
            menu.appendChild(item);
        });

        // Initial Apply
        updateColumnVisibility();
    }

    function updateColumnVisibility() {
        let style = document.getElementById('dynamicColStyles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'dynamicColStyles';
            document.head.appendChild(style);
        }

        let css = '';
        columnConfig.forEach(col => {
            if (!col.checked) {
                // Apply to both th (in index.html) and td (in script.js)
                css += `th.${col.id}, td.${col.id} { display: none !important; }\n`;
            }
        });
        style.textContent = css;
    }

    // Init Logic
    initColumnFilter();

    // PDF Download Logic — Pure jsPDF (no html2canvas)
    const downloadPdfBtn = document.getElementById('downloadPDF');
    if (downloadPdfBtn) {
        downloadPdfBtn.addEventListener('click', () => {
            if (!filteredData || filteredData.length === 0) {
                alert('No data available to generate PDF. Please load data first.');
                return;
            }
            downloadPdfBtn.textContent = 'Generating PDF...';
            downloadPdfBtn.style.opacity = '0.7';
            downloadPdfBtn.style.pointerEvents = 'none';

            try {
                // Access jsPDF from html2pdf bundle
                const { jsPDF } = window.jspdf || {};
                if (!jsPDF) { alert('PDF library not loaded. Please refresh.'); downloadPdfBtn.textContent = 'Download PDF Report'; downloadPdfBtn.style.opacity = '1'; downloadPdfBtn.style.pointerEvents = 'auto'; return; }
                const doc = new jsPDF('p', 'mm', 'a4');
                const pw = 210, ph = 297, ml = 14, mr = 14, mt = 14;
                const cw = pw - ml - mr;
                let y = mt;

                // --- Gather data ---
                const kpiGet = (id) => (document.getElementById(id)?.textContent || '--').trim();
                const kpis = {
                    totalBoq: kpiGet('kpi-boq-records'), totalAct: kpiGet('kpi-act-records'), totalProg: kpiGet('kpi-prog-records'), totalRem: kpiGet('kpi-rem-records'),
                    goodBoq: kpiGet('kpi-boq-concrete'), goodAct: kpiGet('kpi-act-concrete'), goodProg: kpiGet('kpi-prog-concrete'), goodRem: kpiGet('kpi-rem-concrete'),
                    badBoq: kpiGet('kpi-boq-wooden'), badAct: kpiGet('kpi-act-wooden'), badProg: kpiGet('kpi-prog-wooden'), badRem: kpiGet('kpi-rem-wooden'),
                    newBoq: kpiGet('kpi-boq-users'), newAct: kpiGet('kpi-act-users'), newProg: kpiGet('kpi-prog-users'), newRem: kpiGet('kpi-rem-users'),
                    feederBoq: kpiGet('kpi-boq-feeders'), feederAct: kpiGet('kpi-act-feeders'), feederProg: kpiGet('kpi-prog-feeders'),
                    dtBoq: kpiGet('kpi-boq-dts'), dtAct: kpiGet('kpi-act-dts'), dtProg: kpiGet('kpi-prog-dts'),
                    activeUsers: kpiGet('topCardActiveUsers'), completionRate: kpiGet('topCardCompletionRate')
                };
                const vendorCounts = {};
                filteredData.forEach(d => { vendorCounts[d.Vendor_Name || 'Other'] = (vendorCounts[d.Vendor_Name || 'Other'] || 0) + 1; });
                const sortedVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);
                const userCounts = {};
                filteredData.forEach(d => { if (d.User) userCounts[d.User] = (userCounts[d.User] || 0) + 1; });
                const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
                const defects = filteredData.filter(d => d.Issue_Type && d.Issue_Type !== 'Good Condition').length;
                const defectPct = filteredData.length > 0 ? ((defects / filteredData.length) * 100).toFixed(1) : '0';
                const healthPct = filteredData.length > 0 ? (((filteredData.length - defects) / filteredData.length) * 100).toFixed(1) : '0';
                const dtData = getEnhancedDTData();
                const dtRows = dtData.sort((a, b) => b.actualTotal - a.actualTotal).slice(0, 40);
                // Velocity
                const pdfDateStrings = filteredData.map(d => d["Date/timestamp"] ? d["Date/timestamp"].split(' ')[0] : '').filter(Boolean);
                const pdfDates = [...new Set(pdfDateStrings)].sort();
                const pdfActiveDays = pdfDates.length || 1;
                const pdfRunRate = (filteredData.length / pdfActiveDays).toFixed(1);
                const pdfRecent3 = pdfDates.slice(-3);
                const pdfPrev3 = pdfDates.slice(-6, -3);
                const pdfRecentCount = filteredData.filter(d => pdfRecent3.includes((d["Date/timestamp"] || '').split(' ')[0])).length;
                const pdfPrevCount = filteredData.filter(d => pdfPrev3.includes((d["Date/timestamp"] || '').split(' ')[0])).length;
                const pdfRecentRate = pdfRecent3.length > 0 ? Math.round(pdfRecentCount / pdfRecent3.length) : 0;
                const pdfPrevRate = pdfPrev3.length > 0 ? Math.round(pdfPrevCount / pdfPrev3.length) : 0;
                const pdfTrendPct = pdfPrevRate > 0 ? Math.round(((pdfRecentRate - pdfPrevRate) / pdfPrevRate) * 100) : 0;
                const pdfTrending = pdfTrendPct > 5 ? 'accelerating' : pdfTrendPct < -5 ? 'decelerating' : 'holding steady';
                const pdfFirstDate = pdfDates[0] || 'N/A';
                const pdfLastDate = pdfDates[pdfDates.length - 1] || 'N/A';
                const TARGET_RATE = 50;
                let pdfVelocityVerdict = pdfRunRate >= TARGET_RATE ? 'on target' : pdfRunRate >= TARGET_RATE * 0.7 ? 'approaching target' : 'below target';
                // Coverage
                const pdfFeederCount = new Set(filteredData.map(d => d.Feeder).filter(Boolean)).size;
                const pdfDtCount = new Set(filteredData.map(d => d["DT Name"]).filter(Boolean)).size;
                const pdfUtCount = new Set(filteredData.map(d => d.Undertaking).filter(Boolean)).size;
                const pdfBuCount = new Set(filteredData.map(d => d["Bussines Unit"]).filter(Boolean)).size;
                const pdfTotalUsers = Object.keys(userCounts).length;
                const pdfBoqTotal = boqData.length > 0 ? boqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0) : 0;
                const pdfCompletionPct = pdfBoqTotal > 0 ? Math.min(((filteredData.length / pdfBoqTotal) * 100), 100).toFixed(1) : null;
                const pdfPoleTypes = {};
                filteredData.forEach(d => { const t = (d["Type of Pole"] || 'Unknown').toUpperCase(); pdfPoleTypes[t] = (pdfPoleTypes[t] || 0) + 1; });
                const pdfDominantPole = Object.entries(pdfPoleTypes).sort((a, b) => b[1] - a[1])[0];
                const pdfDominantPolePct = pdfDominantPole ? ((pdfDominantPole[1] / filteredData.length) * 100).toFixed(0) : 0;
                // DT status
                const pdfDtCompleted = dtData.filter(r => r.boqTotal > 0 && (r.actualTotal / r.boqTotal) >= 1).length;
                const pdfDtNearComplete = dtData.filter(r => r.boqTotal > 0 && (r.actualTotal / r.boqTotal) >= 0.9 && (r.actualTotal / r.boqTotal) < 1).length;
                const pdfDtInProgress = dtData.filter(r => r.actualTotal > 0 && (r.boqTotal === 0 || (r.actualTotal / r.boqTotal) < 0.9)).length;
                const pdfDtNotStarted = dtData.filter(r => r.actualTotal === 0).length;
                // Vendor officer insights
                const pdfVendorOfficerInsights = ['ETC Workforce', 'Jesom Technology', 'Ikeja Electric'].map(v => {
                    const vU = {}; filteredData.filter(d => d.Vendor_Name === v).forEach(d => { if (d.User) vU[d.User] = (vU[d.User] || 0) + 1; });
                    const s = Object.entries(vU).sort((a, b) => b[1] - a[1]); if (s.length === 0) return null;
                    return { vendor: v, officers: s.length, best: { name: getDisplayName(s[0][0]), count: s[0][1] }, worst: { name: getDisplayName(s[s.length - 1][0]), count: s[s.length - 1][1] }, avg: Math.round(s.reduce((x, u) => x + u[1], 0) / s.length) };
                }).filter(Boolean);
                // Filters
                const getFilterVal = (id) => { const el = document.getElementById(id); if (!el) return 'All'; if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text || 'All'; return el.value || 'All'; };
                const filters = { vendor: getFilterVal('vendorFilter'), bu: getFilterVal('buFilter'), ut: getFilterVal('utFilter'), user: getFilterVal('userFilter') };
                const activeFilters = Object.entries(filters).filter(([, v]) => v !== 'All' && v !== 'All Vendors' && v !== 'All Business Units' && v !== 'All Undertakings' && v !== 'All Users');
                const filterText = activeFilters.length > 0 ? activeFilters.map(([k, v]) => `${k}: ${v}`).join(' | ') : 'No filters applied (All Data)';
                const now = new Date();
                const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                // === HELPERS ===
                const checkPage = (need) => { if (y + need > ph - 14) { doc.addPage(); y = mt; } };
                const setColor = (hex) => { const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16); return [r, g, b]; };
                const drawLine = (y1) => { doc.setDrawColor(200); doc.line(ml, y1, pw - mr, y1); };
                // Wrap text into lines that fit maxWidth
                const wrapText = (text, maxWidth, fontSize) => {
                    doc.setFontSize(fontSize);
                    const words = text.split(' ');
                    const lines = []; let line = '';
                    words.forEach(w => {
                        const test = line ? line + ' ' + w : w;
                        if (doc.getTextWidth(test) > maxWidth) { if (line) lines.push(line); line = w; }
                        else { line = test; }
                    });
                    if (line) lines.push(line);
                    return lines;
                };
                // Draw a simple table
                const drawTable = (headers, rows, colWidths, opts = {}) => {
                    const fs = opts.fontSize || 8;
                    const rh = opts.rowHeight || 6;
                    const hdrBg = opts.headerBg || [30, 64, 175];
                    doc.setFontSize(fs);
                    // Header
                    checkPage(rh * 3);
                    doc.setFillColor(...hdrBg);
                    doc.rect(ml, y, cw, rh + 2, 'F');
                    doc.setTextColor(255, 255, 255);
                    doc.setFont('helvetica', 'bold');
                    let cx = ml + 1;
                    headers.forEach((h, i) => {
                        doc.text(h, cx + 1, y + rh - 0.5);
                        cx += colWidths[i];
                    });
                    y += rh + 2;
                    // Rows
                    doc.setFont('helvetica', 'normal');
                    rows.forEach((row, ri) => {
                        checkPage(rh + 1);
                        if (ri % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(ml, y, cw, rh + 1, 'F'); }
                        doc.setTextColor(30, 30, 30);
                        cx = ml + 1;
                        row.forEach((cell, ci) => {
                            const txt = String(cell).substring(0, Math.floor(colWidths[ci] / 1.8));
                            doc.text(txt, cx + 1, y + rh - 0.5);
                            cx += colWidths[ci];
                        });
                        // Grid lines
                        doc.setDrawColor(220); cx = ml;
                        colWidths.forEach(w => { doc.line(cx, y, cx, y + rh + 1); cx += w; });
                        doc.line(cx, y, cx, y + rh + 1);
                        doc.line(ml, y + rh + 1, ml + cw, y + rh + 1);
                        y += rh + 1;
                    });
                    y += 3;
                };

                // === HEADER ===
                doc.setFillColor(30, 64, 175);
                doc.rect(0, 0, pw, 22, 'F');
                doc.setTextColor(255, 255, 255);
                doc.setFontSize(16); doc.setFont('helvetica', 'bold');
                doc.text('IDB 2.0 ASSETS TAGGING MONITORING REPORT', pw / 2, 10, { align: 'center' });
                doc.setFontSize(9); doc.setFont('helvetica', 'normal');
                doc.text(`Generated: ${dateStr} at ${timeStr}  |  ${filterText}`, pw / 2, 17, { align: 'center' });
                y = 28;

                // === EXECUTIVE INSIGHTS ===
                doc.setFillColor(248, 250, 252);
                const insightStartY = y;
                // We'll draw the background after we know the height

                doc.setFontSize(12); doc.setFont('helvetica', 'bold');
                doc.setTextColor(...setColor('#1e40af'));
                doc.text('EXECUTIVE SUMMARY & DASHBOARD INSIGHTS', ml + 3, y + 5);
                y += 10;

                // Paragraph helper
                const writeParagraph = (text, indent) => {
                    const lines = wrapText(text, cw - (indent || 6), 8.5);
                    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(51, 65, 85);
                    lines.forEach(line => {
                        checkPage(4.5);
                        doc.text(line, ml + (indent || 3), y);
                        y += 4;
                    });
                    y += 2;
                };

                // Project overview
                writeParagraph(
                    `The IDB 2.0 Asset Enumeration project has captured a total of ${filteredData.length.toLocaleString()} pole assets across ${pdfBuCount} Business Unit${pdfBuCount > 1 ? 's' : ''}, covering ${pdfFeederCount} feeders, ${pdfDtCount} distribution transformers, and ${pdfUtCount} undertaking${pdfUtCount > 1 ? 's' : ''}. A workforce of ${pdfTotalUsers} active field officers has been deployed across all vendor teams. Data collection spans from ${pdfFirstDate} to ${pdfLastDate} (${pdfActiveDays} active working days).`
                );

                // Velocity
                writeParagraph(
                    `Project Velocity: The current run rate stands at ${pdfRunRate} poles/day, which is ${pdfVelocityVerdict} against the benchmark of ${TARGET_RATE} poles/day. The recent 3-day trend is ${pdfTrending}${Math.abs(pdfTrendPct) > 0 ? ` (${pdfTrendPct > 0 ? '+' : ''}${pdfTrendPct}% compared to the prior 3-day period)` : ''}.${pdfCompletionPct !== null ? ` Overall BOQ completion stands at ${pdfCompletionPct}% (${filteredData.length.toLocaleString()} of ${pdfBoqTotal.toLocaleString()} target poles).` : ''}`
                );

                // Asset health
                writeParagraph(
                    `Asset Health Assessment: Of the ${filteredData.length.toLocaleString()} poles surveyed, ${healthPct}% are in good condition while ${defects.toLocaleString()} poles (${defectPct}%) require attention (replacement or repair).${pdfDominantPole ? ` The dominant pole material is ${pdfDominantPole[0].charAt(0) + pdfDominantPole[0].slice(1).toLowerCase()}, accounting for ${pdfDominantPolePct}% of all surveyed assets.` : ''} ${parseFloat(defectPct) > 25 ? 'The defect rate is elevated and warrants immediate field review.' : parseFloat(defectPct) > 15 ? 'The defect rate is moderate; targeted maintenance is recommended.' : 'The asset health ratio is within acceptable parameters.'}`
                );

                // Vendor performance
                const vendorText = sortedVendors.map(([name, count]) => `${name} has tagged ${count.toLocaleString()} assets (${((count / filteredData.length) * 100).toFixed(1)}%)`).join(', ');
                writeParagraph(`Vendor Performance: ${vendorText}.${sortedVendors.length > 1 ? ` ${sortedVendors[0][0]} leads the enumeration effort.` : ''}`);

                // Officer performance
                if (pdfVendorOfficerInsights.length > 0) {
                    const officerText = pdfVendorOfficerInsights.map(v => `Under ${v.vendor} (${v.officers} officers), top: ${v.best.name} (${v.best.count} poles), lowest: ${v.worst.name} (${v.worst.count} poles, avg: ${v.avg}/officer)`).join('. ');
                    writeParagraph(`Field Officer Performance: ${officerText}.${sortedUsers.length > 0 ? ` Overall leader: ${getDisplayName(sortedUsers[0][0])} with ${sortedUsers[0][1].toLocaleString()} assets.` : ''}`);
                }

                // DT progress
                writeParagraph(`DT Progress Overview: Out of ${dtData.length} distribution transformers tracked: ${pdfDtCompleted} completed, ${pdfDtNearComplete} near completion, ${pdfDtInProgress} in progress, and ${pdfDtNotStarted} not yet started.${pdfDtNotStarted > 0 ? ` The ${pdfDtNotStarted} unstarted DTs should be prioritized in the next deployment cycle.` : ' All tracked DTs have commenced operations.'}`);

                // Recommendations
                doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#92400e'));
                checkPage(6);
                doc.text('KEY RECOMMENDATIONS:', ml + 3, y); y += 4;
                doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 53, 15);
                const recs = [];
                if (parseFloat(pdfRunRate) < TARGET_RATE) recs.push(`Increase daily run rate from ${pdfRunRate} to meet the ${TARGET_RATE} poles/day target.`);
                else recs.push(`Maintain current run rate of ${pdfRunRate} poles/day which meets the project target.`);
                if (parseFloat(defectPct) > 15) recs.push(`Investigate the ${defectPct}% defect rate. Prioritize replacement of damaged poles.`);
                if (pdfDtNotStarted > 0) recs.push(`Mobilize resources for the ${pdfDtNotStarted} unstarted DTs to prevent timeline slippage.`);
                if (pdfVendorOfficerInsights.some(v => v.worst.count < v.avg * 0.5)) recs.push('Address performance gaps among lower-performing officers via training.');
                recs.push('Continue daily monitoring and schedule weekly vendor review meetings.');
                recs.forEach(r => {
                    const lines = wrapText('  - ' + r, cw - 6, 8);
                    lines.forEach(l => { checkPage(4); doc.text(l, ml + 5, y); y += 3.8; });
                });
                y += 2;

                // Draw insight background
                const insightH = y - insightStartY;
                // Draw on page 1 behind text — use rect with light fill
                const totalPages = doc.internal.getNumberOfPages();
                for (let p = 1; p <= totalPages; p++) {
                    doc.setPage(p);
                    if (p === 1) {
                        doc.setFillColor(248, 250, 252); doc.setDrawColor(30, 64, 175);
                        doc.rect(ml - 1, insightStartY - 2, cw + 2, Math.min(insightH + 4, ph - insightStartY), 'D');
                    }
                }
                doc.setPage(totalPages);

                // === KPI TABLE ===
                y += 4; checkPage(10);
                doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#1e40af'));
                doc.text('KEY PERFORMANCE INDICATORS', ml, y); y += 2; drawLine(y); y += 4;
                const kpiHeaders = ['Metric', 'Expected', 'Actual', 'Progress', 'Remaining'];
                const kpiColW = [cw * 0.30, cw * 0.17, cw * 0.17, cw * 0.18, cw * 0.18];
                const kpiRows = [
                    ['Total Poles', kpis.totalBoq, kpis.totalAct, kpis.totalProg, kpis.totalRem],
                    ['Good Condition', kpis.goodBoq, kpis.goodAct, kpis.goodProg, kpis.goodRem],
                    ['Bad Poles (Replace)', kpis.badBoq, kpis.badAct, kpis.badProg, kpis.badRem],
                    ['New Poles (Install)', kpis.newBoq, kpis.newAct, kpis.newProg, kpis.newRem],
                    ['Feeders', kpis.feederBoq, kpis.feederAct, kpis.feederProg, '-'],
                    ['DTs', kpis.dtBoq, kpis.dtAct, kpis.dtProg, '-']
                ];
                drawTable(kpiHeaders, kpiRows, kpiColW);

                // === SUMMARY METRICS ===
                checkPage(14);
                const metricBoxW = cw / 4;
                const metrics = [
                    { label: 'Active Users', val: kpis.activeUsers, bg: [239, 246, 255], color: '#1e40af' },
                    { label: 'Completion Rate', val: kpis.completionRate, bg: [240, 253, 244], color: '#059669' },
                    { label: 'Asset Health', val: healthPct + '%', bg: [254, 252, 232], color: '#d97706' },
                    { label: 'Defects Found', val: defects.toLocaleString(), bg: [254, 242, 242], color: '#dc2626' }
                ];
                metrics.forEach((m, i) => {
                    const bx = ml + i * metricBoxW;
                    doc.setFillColor(...m.bg); doc.roundedRect(bx + 1, y, metricBoxW - 2, 12, 1, 1, 'F');
                    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(100);
                    doc.text(m.label.toUpperCase(), bx + metricBoxW / 2, y + 4, { align: 'center' });
                    doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor(m.color));
                    doc.text(String(m.val), bx + metricBoxW / 2, y + 10.5, { align: 'center' });
                });
                y += 17;

                // === VENDOR TABLE ===
                checkPage(10);
                doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#1e40af'));
                doc.text('VENDOR PERFORMANCE BREAKDOWN', ml, y); y += 2; drawLine(y); y += 4;
                const vHeaders = ['Vendor', 'Assets Tagged', 'Share'];
                const vColW = [cw * 0.45, cw * 0.30, cw * 0.25];
                const vRows = sortedVendors.map(([name, count]) => [name, count.toLocaleString(), ((count / filteredData.length) * 100).toFixed(1) + '%']);
                vRows.push(['TOTAL', filteredData.length.toLocaleString(), '100%']);
                drawTable(vHeaders, vRows, vColW);

                // === TOP OFFICERS ===
                checkPage(10);
                doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#1e40af'));
                doc.text('TOP FIELD OFFICERS (BY ASSETS TAGGED)', ml, y); y += 2; drawLine(y); y += 4;
                const uHeaders = ['#', 'Officer', 'Assets', 'Share'];
                const uColW = [cw * 0.08, cw * 0.50, cw * 0.22, cw * 0.20];
                const uRows = sortedUsers.slice(0, 20).map(([user, count], i) => [
                    String(i + 1), getDisplayName(user), count.toLocaleString(), ((count / filteredData.length) * 100).toFixed(1) + '%'
                ]);
                drawTable(uHeaders, uRows, uColW);

                // === DT TABLE ===
                checkPage(10);
                doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#1e40af'));
                const dtTitle = `DT PERFORMANCE ANALYSIS${dtRows.length < dtData.length ? ` (Top ${dtRows.length} of ${dtData.length})` : ''}`;
                doc.text(dtTitle, ml, y); y += 2; drawLine(y); y += 4;
                const dHeaders = ['#', 'DT Name', 'Feeder', 'Vendor', 'Exp.', 'Act.', 'Good', 'Bad', 'Prog.', 'Status'];
                const dColW = [cw*0.04, cw*0.18, cw*0.15, cw*0.12, cw*0.07, cw*0.07, cw*0.07, cw*0.06, cw*0.08, cw*0.16];
                const dRows = dtRows.map((row, i) => {
                    const prog = row.boqTotal > 0 ? ((row.actualTotal / row.boqTotal) * 100).toFixed(1) : '0.0';
                    let status = 'In Progress';
                    if (row.actualTotal === 0) status = 'Not Started';
                    else if (parseFloat(prog) >= 100) status = 'Completed';
                    else if (parseFloat(prog) > 90) status = 'Near Complete';
                    return [String(i + 1), row.dtName, row.feeder, row.vendor, String(row.boqTotal), String(row.actualTotal), String(row.concrete), String(row.wooden), prog + '%', status];
                });
                drawTable(dHeaders, dRows, dColW, { fontSize: 6.5, rowHeight: 5 });

                // === FOOTER on all pages ===
                const totalPgs = doc.internal.getNumberOfPages();
                for (let p = 1; p <= totalPgs; p++) {
                    doc.setPage(p);
                    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(150);
                    doc.text(`IDB 2.0 Monitoring System  |  Page ${p} of ${totalPgs}  |  Report generated ${dateStr}`, pw / 2, ph - 6, { align: 'center' });
                }

                // === SAVE ===
                doc.save(`IDB_Dashboard_Report_${new Date().toISOString().split('T')[0]}.pdf`);
                downloadPdfBtn.textContent = 'Download PDF Report';
                downloadPdfBtn.style.opacity = '1';
                downloadPdfBtn.style.pointerEvents = 'auto';

            } catch (err) {
                console.error('PDF Build Error:', err);
                alert('Failed to build PDF report: ' + err.message);
                downloadPdfBtn.textContent = 'Download PDF Report';
                downloadPdfBtn.style.opacity = '1';
                downloadPdfBtn.style.pointerEvents = 'auto';
            }
        });
    }

}); // End DOMContentLoaded
