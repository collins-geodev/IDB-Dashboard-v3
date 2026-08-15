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
    let dtLayer = null;             // Distribution Transformer markers (derived centroids)
    let mapLayersControl = null;    // base/overlay layer switcher (for adding DT overlay)
    let dtHighlightLayer = null;    // animated "connected poles" highlight for a clicked DT
    let dtHighlightControl = null;  // vendor legend shown while a DT is highlighted
    let highlightedDtName = null;   // which DT is currently highlighted (toggle state)
    let dtHlPoles = [];             // cached connected poles [{lat,lon,key}] for the active DT
    let dtHlCounts = null;          // per-vendor pole counts for the active DT
    let dtHlSelected = null;        // Set of vendor keys currently shown (legend selection)
    let dtHlLegendDiv = null;       // legend DOM node, updated in place as vendors are toggled
    let boundariesLoaded = false;   // one-time load guard
    let utBoundsCache = null;       // UT-only bounds (fallback when no data)
    let mapInitiallyFitted = false; // first-render fit guard
    let pulseTimer = null;          // setTimeout id for pulse auto-stop
    let mapBases = {};              // { dark, light, satellite, hybrid } base tile layers
    let lastMapFilterSig = null;    // signature of the last filtered set drawn on the map

    // ── Asset (SLRN) index ───────────────────────────────────────────────
    // Pole SLRNs and Building SLRNs are identifiers, not categories — ~10k and
    // ~15k distinct values — so they are looked up, never browsed in a dropdown.
    // These two maps are built once per data load and make every lookup O(1)
    // instead of re-scanning + re-splitting all 11k rows on each keystroke.
    let poleIndex = new Map();      // poleSLRN     -> Set<buildingSLRN>
    let buildingIndex = new Map();  // buildingSLRN -> Set<poleSLRN>
    let assetLookupQuery = '';      // active "Asset SLRN" filter term (upper-case)
    const expandedDTKeys = new Set();  // DT rows the user drilled into (feeder|dt)
    const collapsedDTKeys = new Set(); // DT rows closed *while* a lookup auto-opens them
    let autoExpandActive = false;      // set by renderDTTable; read by the toggle handler
    // With an Asset SLRN lookup active the matching DT rows open themselves, but
    // only when the search actually narrowed things down — a broad prefix that
    // still matches hundreds of DTs should not expand a whole page of registers.
    const AUTO_EXPAND_MAX_DTS = 10;

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
        // Every filter routes through the same faceted cascade: selecting any one
        // narrows the options in all the others (see cascadeAllFilters).
        const filterConfigs = {
            vendorFilter:   { onChange: () => handleFilterChange('vendorFilter') },
            buFilter:       { onChange: () => handleFilterChange('buFilter') },
            utFilter:       { onChange: () => handleFilterChange('utFilter') },
            userFilter:     { onChange: () => handleFilterChange('userFilter') },
            feederFilter:   { onChange: () => handleFilterChange('feederFilter') },
            dtFilter:       { onChange: () => handleFilterChange('dtFilter') },
            upriserFilter:  { onChange: () => handleFilterChange('upriserFilter') },
            materialFilter: { allValue: '', onChange: () => handleFilterChange('materialFilter') },
            dateFilter:     { onChange: () => handleFilterChange('dateFilter') },
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

    // Tracks usernames that miss every vendor list so each is logged only once
    const unmappedVendorUsers = new Set();

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
            'adamilare', 'kismail', 'aakinbode', 'fmohammed'
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

        // Fallback heuristic: Many ETC users start with 'a' followed by a name;
        // everyone else defaults to Ikeja Electric (no 'Other' classification)
        const fallbackVendor = (user && user.startsWith('a') && user.length > 3)
            ? 'ETC Workforce'
            : 'Ikeja Electric';
        if (user && !unmappedVendorUsers.has(user)) {
            unmappedVendorUsers.add(user);
            console.warn(`[Vendor Mapping] User "${user}" not in any vendor list — defaulting to ${fallbackVendor}`);
        }
        return fallbackVendor;
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

    // Split an "Associated Buildings SLRN" cell into clean building SLRNs.
    // The captured format is inconsistent — the delimiter is usually "; " but
    // often " ;" with a trailing separator ("IESH023257 ;IESH023258 ;"), so the
    // tokens must be trimmed and the phantom empty tail dropped. Values are
    // de-duplicated because 2,216 rows repeat the same SLRN inside one cell
    // (e.g. "IESH008706 ;IESH008706 ;IESH008706 ;"), which inflates the stored
    // "No of Buildings Connected" count.
    function parseBuildings(raw) {
        return [...new Set(
            String(raw || '')
                .split(';')
                .map(s => s.trim().toUpperCase())
                .filter(Boolean)
        )];
    }

    // Build the pole ↔ building lookup maps in a single pass over the dataset.
    // ~21k pole/building pairs index in a few milliseconds, once per load.
    function buildAssetIndex(data) {
        poleIndex = new Map();
        buildingIndex = new Map();

        (data || []).forEach(item => {
            const pole = String(item["Lt PoleSLRN"] || item["LT Pole No"] || '').trim().toUpperCase();
            if (!pole) return;

            if (!poleIndex.has(pole)) poleIndex.set(pole, new Set());
            const bucket = poleIndex.get(pole);

            parseBuildings(item["Associated Buildings SLRN"]).forEach(b => {
                bucket.add(b);
                if (!buildingIndex.has(b)) buildingIndex.set(b, new Set());
                buildingIndex.get(b).add(pole);
            });
        });

        const shared = [...buildingIndex.values()].filter(s => s.size > 1).length;
        console.log(`[Asset Index] ${poleIndex.size} poles ↔ ${buildingIndex.size} buildings` +
            (shared ? ` · ${shared} building(s) attached to more than one pole` : ''));
    }

    // Buildings for a single record, honouring the index so repeated captures of
    // the same pole show the full unioned list rather than just this row's cell.
    function buildingsForRecord(item) {
        const pole = String(item["Lt PoleSLRN"] || item["LT Pole No"] || '').trim().toUpperCase();
        const fromIndex = pole && poleIndex.get(pole);
        return fromIndex ? [...fromIndex] : parseBuildings(item["Associated Buildings SLRN"]);
    }

    // Does a record match the Asset SLRN lookup? Matches the LT Pole SLRN, or
    // any Building SLRN attached to that pole (so a building ID resolves back to
    // the pole it hangs on). Shared by applyFilters() and the filter cascade so
    // both agree on exactly what "matched" means.
    function matchesAssetLookup(item, q) {
        if (!q) return true;
        const pole = String(item["Lt PoleSLRN"] || item["LT Pole No"] || '').toUpperCase();
        if (pole.includes(q)) return true;
        return buildingsForRecord(item).some(b => b.includes(q));
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

    // A pole record counts as a NEW installation (feeds the "New Poles
    // (Install)" KPI) when it carries the "Pole Category = New Install" flag
    // from the field-capture template, or — legacy — a Pole_Type/Issue_Type
    // that mentions "new". Tolerates a few field-name/spelling variants so the
    // KPI auto-updates as soon as captured new poles land in the dataset.
    function isNewInstallPole(item) {
        if (!item) return false;
        var cat = String(item["Pole Category"] || item["Pole_Category"] ||
            item["PoleCategory"] || item["Category"] || "").toLowerCase();
        if (cat.indexOf('new') >= 0) return true;
        var pt = String(item.Pole_Type || item["Pole_Type"] || "").toLowerCase();
        var it = String(item.Issue_Type || item["Issue_Type"] || "").toLowerCase();
        return pt.indexOf('new') >= 0 || it.indexOf('new') >= 0;
    }

    // ── Canonical pole counting ─────────────────────────────────────────────
    // A "pole" is a unique SLRN (a pole captured twice is still one pole) — this
    // is how the KPI cards count. The executive summary and vendor recommendations
    // use these so every headline on the page agrees.
    function poleSlrn(item) {
        return String((item && (item["Lt PoleSLRN"] || item["LT Pole No"])) || "").trim();
    }
    function countUniquePoles(arr) {
        var s = new Set();
        arr.forEach(function (d) { var x = poleSlrn(d); if (x) s.add(x); });
        return s.size;
    }
    // { key: uniquePoleCount } grouped by keyFn (blank keys and SLRN-less rows skipped).
    function uniquePolesByGroup(arr, keyFn) {
        var m = {};
        arr.forEach(function (d) {
            var k = keyFn(d); if (k == null || k === '') return;
            var x = poleSlrn(d); if (!x) return;
            (m[k] = m[k] || new Set()).add(x);
        });
        var out = {};
        Object.keys(m).forEach(function (k) { out[k] = m[k].size; });
        return out;
    }
    // Like uniquePolesByGroup, but each unique pole is attributed to ONE group (the
    // first row that carries it) — so the group counts sum to the total. Used for
    // "contribution" splits (e.g. vendor bars) that must add up to 100%.
    function uniquePolesByGroupExclusive(arr, keyFn) {
        var assigned = new Set(), out = {};
        arr.forEach(function (d) {
            var x = poleSlrn(d); if (!x || assigned.has(x)) return;
            var k = keyFn(d); if (k == null || k === '') return;
            assigned.add(x); out[k] = (out[k] || 0) + 1;
        });
        return out;
    }
    // Building-SLRN linkage over unique poles: how many poles carry an associated
    // building SLRN (a real data-completeness signal, unlike the simulated Issue_Type).
    function buildingLinkage(arr) {
        var all = new Set(), linked = new Set();
        arr.forEach(function (d) {
            var x = poleSlrn(d); if (!x) return;
            all.add(x);
            if (String(d["Associated Buildings SLRN"] || "").trim()) linked.add(x);
        });
        var total = all.size, l = linked.size;
        return { total: total, linked: l, unlinked: total - l, pct: total ? (l / total * 100) : 0 };
    }
    // Count of distinct building SLRNs (semicolon-separated) connected across the set.
    function uniqueBuildings(arr) {
        var s = new Set();
        arr.forEach(function (d) {
            String(d["Associated Buildings SLRN"] || "").split(";").forEach(function (b) {
                var t = b.trim(); if (t) s.add(t);
            });
        });
        return s.size;
    }

    // Initialize Dashboard
    // Initialize Dashboard - Auto Fetch
    // CRITICAL: Data now lives in Convex file storage. To update it, run:
    //   npx convex run --prod assets:importFromUrls '{"sources":[{"name":"converted_data_latest.json","url":"<public url of new file>"}]}'
    // or replace the file in the Convex dashboard (assets table + storage).
    const CONVEX_SITE = (window.IDB && window.IDB.SITE_URL) || "";
    const fieldDataUrls = CONVEX_SITE
        ? [CONVEX_SITE + "/assets/converted_data_latest.json"]
        : [];

    const boqDataUrls = CONVEX_SITE
        ? [CONVEX_SITE + "/assets/BOQ-IDB.json"]
        : [];

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

    // Load (or reload) every dataset the dashboard renders from, then rebuild
    // the whole UI. Wrapped in a function so an admin JSON upload can re-run the
    // exact same pipeline in place (re-fetch from Convex → re-apply this
    // dashboard's feeder scope → re-render) without a full page refresh.
    // opts.reapplyFilters: on a RELOAD (e.g. after a JSON upload), recompute
    // filteredData through applyFilters() so any filter selections the user
    // still has active stay consistent with the KPIs/charts/map — the initial
    // load leaves it undefined and renders the full dataset directly.
    function loadDashboardData(opts) {
      opts = opts || {};
      return Promise.all([
        fetchWithFallback(
            fieldDataUrls,
            './converted_data_latest.json',
            'https://raw.githubusercontent.com/collins-geodev/IDB-Dashboard-v3/main/converted_data_latest.json'
        ),
        fetchWithFallback(
            boqDataUrls,
            './BOQ-IDB.json',
            'https://raw.githubusercontent.com/collins-geodev/IDB-Dashboard-v3/main/BOQ-IDB.json'
        ),
        // Shared uploaded poles (visible to all users). Empty if the backend
        // has no uploads or the query isn't available — never blocks the load.
        (window.IDB && IDB.query)
            ? IDB.query('poleUploads:list').catch(() => [])
            : Promise.resolve([])
    ])
    .catch(error => {
        // True network / fetch failures land here — log silently, never
        // show a blocking alert. If data truly failed, the empty dashboard
        // is the clearest signal; developers can inspect the console.
        console.error('[Dashboard] Error fetching data from all sources:', error);
        return [null, null, []];
    })
    .then(([fieldData, boq, sharedUploads]) => {
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

        // Per-dashboard feeder scope comes from dashboard-config.js (resolved by
        // hostname): v3 -> a 20-feeder SHOMOLU allowlist; v2 -> null (show all).
        // When an allowlist is present, restrict BOTH the field dataset (Feeder)
        // and the BOQ targets (FEEDER NAME) at load time, independent of the data
        // source (Convex / local / GitHub raw), so every KPI card (Actual AND
        // target), chart, filter and map reflects only those feeders even while
        // Convex still holds the full file. Matched case-insensitively, trimmed.
        const _cfgVariant = (window.IDB_CONFIG && window.IDB_CONFIG.variant) || 'v3';
        const _allowedFeeders = (window.IDB_CONFIG && window.IDB_CONFIG.allowedFeeders) || null;
        if (Array.isArray(_allowedFeeders) && _allowedFeeders.length) {
            const _n = _allowedFeeders.length;
            const _allowedFeederSet = new Set(_allowedFeeders.map(f => f.trim().toLowerCase()));
            if (Array.isArray(fieldData)) {
                const _before = fieldData.length;
                fieldData = fieldData.filter(r => _allowedFeederSet.has(String((r && r.Feeder) || '').trim().toLowerCase()));
                console.log(`[${_cfgVariant}] Feeder allowlist (field): ${fieldData.length}/${_before} records kept (${_n} approved feeders).`);
            }
            if (Array.isArray(boq)) {
                const _bqBefore = boq.length;
                boq = boq.filter(r => _allowedFeederSet.has(String((r && r['FEEDER NAME']) || '').trim().toLowerCase()));
                console.log(`[${_cfgVariant}] Feeder allowlist (BOQ): ${boq.length}/${_bqBefore} rows kept (${_n} approved feeders).`);
            }
        } else {
            console.log(`[${_cfgVariant}] No feeder allowlist — showing all feeders in the dataset.`);
        }
        try {
            // Process Field Data
            fieldData.forEach(item => {
                item.Vendor_Name = inferVendor(item.User);
                if (!item.Issue_Type) item.Issue_Type = simulateIssue(item);
            });
            // Fresh canonical base: drop any prior shared-upload snapshot so the
            // merge below re-snapshots from this reload (matters when the pipeline
            // is re-run after an admin JSON upload).
            templateOriginalSnapshot = null;
            globalData = fieldData;
            filteredData = fieldData;

            // Merge the shared uploaded poles (from Convex) so every viewer sees
            // them — scoped to this dashboard's allowed feeders.
            const sharedUploadCount = applySharedUploads(sharedUploads);

            // Detect duplicate SLRNs before rendering
            detectDuplicateSLRNs(globalData);

            // Index pole ↔ building SLRNs for the Asset lookup and DT drill-down
            buildAssetIndex(globalData);

            // Process BOQ Data
            boqData = boq;
            console.log("Total Data Loaded:", boqData.length);

            // Unlock Toggle
            const toggleWrapper = document.getElementById('viewModeWrapper');
            if (toggleWrapper) toggleWrapper.style.display = 'flex';

            populateFilters();
            // On a reload, re-narrow filteredData to whatever filters are still
            // selected (applyFilters() recomputes it, then renders); on first
            // load there are no selections yet, so render the full set directly.
            if (opts.reapplyFilters) applyFilters();
            else updateDashboard();
            updateExecutiveSummary();
            refreshPreviewBadge(); // show the shared "+N" badge / Clear item on load

            document.querySelectorAll('.last-updated').forEach(el => {
                el.textContent = `Last Updated: ${new Date().toLocaleTimeString()}` +
                    (sharedUploadCount ? ' · ' + sharedUploadCount + ' uploaded pole(s)' : '');
            });
        } catch (processingError) {
            // Post-fetch runtime errors (rendering, filter population, etc.)
            // Log loudly but do NOT show the misleading "network connection" alert.
            console.error('Dashboard processing error after successful data load:', processingError);
        }
    });
    }
    loadDashboardData();

    // Initialize multi-select filter dropdowns
    initMultiSelects();

    // Initialize the Pole / Building SLRN identifier lookup + DT drill-down
    initAssetLookup();
    initDrillDown();


    document.getElementById('viewModeToggle').addEventListener('change', handleViewModeToggle);
    document.getElementById('downloadExcel').addEventListener('click', downloadExcel);
    document.getElementById('downloadCSV')?.addEventListener('click', downloadCSV);
    document.getElementById('dtSearchInput')?.addEventListener('input', () => {
        renderDTTable();
    });

    // ── Theme toggle (dark ↔ light) ──────────────────────────────────────
    // The theme itself is already applied in index.html's <head> (no flash);
    // here we sync the button UI and handle clicks + persistence, re-rendering
    // charts so their canvas/SVG colours follow the new theme.
    function applyTheme(mode, persist) {
        const theme = mode === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        if (persist) { try { localStorage.setItem('idb-theme', theme); } catch (e) {} }
        const btn = document.getElementById('themeToggle');
        if (btn) {
            const icon = btn.querySelector('.theme-toggle-icon');
            const label = btn.querySelector('.theme-toggle-label');
            if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
            if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
            btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
        }
        syncMapBaseToTheme();
    }

    // Switch the map's basemap to match the dashboard theme (dark ↔ light). Only
    // acts when the map is currently on the Dark/Light basemap — a manual
    // Satellite/Hybrid choice is left untouched.
    function syncMapBaseToTheme() {
        if (!map || !mapBases.dark || !mapBases.light) return;
        if (map.hasLayer(mapBases.satellite) || map.hasLayer(mapBases.hybrid)) return;
        const wantLight = document.documentElement.getAttribute('data-theme') === 'light';
        const want = wantLight ? mapBases.light : mapBases.dark;
        const other = wantLight ? mapBases.dark : mapBases.light;
        if (!map.hasLayer(want)) {
            if (map.hasLayer(other)) map.removeLayer(other);
            want.addTo(map);
        }
    }
    (function initThemeToggle() {
        let saved = 'dark';
        try { saved = localStorage.getItem('idb-theme') === 'light' ? 'light' : 'dark'; } catch (e) {}
        applyTheme(saved, false); // sync button UI with the already-applied theme
        const btn = document.getElementById('themeToggle');
        if (btn) {
            btn.addEventListener('click', () => {
                const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
                applyTheme(next, true);
                try {
                    if (typeof updateDashboard === 'function' && Array.isArray(filteredData) && filteredData.length) {
                        updateDashboard();
                    }
                } catch (e) { console.warn('Theme re-render failed:', e); }
            });
        }
    })();

    // ── Unified export dropdown (Excel / CSV / PDF) open-close ────────────
    (function initExportDropdown() {
        const dd = document.getElementById('exportDropdown');
        const toggle = document.getElementById('exportDropdownToggle');
        const menu = document.getElementById('exportDropdownMenu');
        if (!dd || !toggle || !menu) return;
        // Close the sibling New-Pole Template dropdown so both can't be open at once
        // (its toggle calls stopPropagation, so the document listeners don't cross-close).
        const closeSiblingTemplate = () => {
            const tdd = document.getElementById('templateDropdown');
            const tmenu = document.getElementById('templateDropdownMenu');
            const ttog = document.getElementById('templateDropdownToggle');
            if (tdd) tdd.classList.remove('open');
            if (tmenu) tmenu.hidden = true;
            if (ttog) ttog.setAttribute('aria-expanded', 'false');
        };
        const open = () => { closeSiblingTemplate(); dd.classList.add('open'); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };
        const close = () => { dd.classList.remove('open'); menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
        toggle.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); });
        menu.querySelectorAll('.template-dropdown-item').forEach(item => item.addEventListener('click', close));
        document.addEventListener('click', (e) => { if (!dd.contains(e.target)) close(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
        // Opening the sibling template dropdown must close this one (its own
        // stopPropagation prevents the document listener above from firing).
        document.getElementById('templateDropdownToggle')?.addEventListener('click', close);
    })();

    // Parse the field-capture timestamp ("MM/DD/YYYY HH:mm") into a comparable
    // millisecond value. Returns NaN when it can't be parsed.
    function parseFieldTimestamp(ts) {
        if (!ts) return NaN;
        const m = ts.toString().trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
        if (!m) return NaN;
        const [, mm, dd, yyyy, hh = "0", mi = "0"] = m;
        return new Date(+yyyy, +mm - 1, +dd, +hh, +mi).getTime();
    }

    // Collapse duplicate poles (same key) into one cleaned row so the export
    // matches the unique-pole counts the dashboard shows. The key is identical to
    // the one every KPI uses: Lt PoleSLRN, falling back to LT Pole No.
    //   • Associated Building SLRNs are UNIONed across every capture of the pole
    //     (trimmed + de-duplicated) and "No of Buildings Connected" is recomputed —
    //     no captured building is ever dropped.
    //   • Every other field takes the most recent NON-BLANK value (latest capture
    //     wins, falling back to earlier captures only where the latest is empty).
    //   • Internal runtime flags (keys starting with "__") are omitted; provenance
    //     columns (Captures Merged / First / Last Captured) are appended.
    // Rows with no key at all are passed through as their own single row.
    function mergeDuplicatesBySLRN(data) {
        const BLDG_FIELD = "Associated Buildings SLRN";
        const COUNT_FIELD = "No of Buildings Connected to the Pole";
        const keyOf = it => (it["Lt PoleSLRN"] || it["LT Pole No"] || "").toString().trim();
        const isBlank = v => v === undefined || v === null || v.toString().trim() === "";
        const isInternal = k => k.charAt(0) === "_" && k.charAt(1) === "_";
        const fmt = d => d
            ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()} ` +
              `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
            : "";

        // Column order = first-seen union of every real (non-internal) key, so
        // uploaded-pole fields survive while runtime flags (__source, …) don't.
        const columns = [];
        const colSeen = new Set();
        data.forEach(item => Object.keys(item).forEach(k => {
            if (!isInternal(k) && !colSeen.has(k)) { colSeen.add(k); columns.push(k); }
        }));

        const groups = new Map();   // key -> [records]
        const passthrough = [];     // records with no usable key
        data.forEach(item => {
            const key = keyOf(item);
            if (!key) { passthrough.push(item); return; }
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });

        // Build one cleaned row from a group of captures (already ordered newest-first).
        const buildRow = (rows, ordered) => {
            const seen = new Set();
            const buildings = [];
            ordered.forEach(r => {
                (r[BLDG_FIELD] || "").toString().split(";").forEach(tok => {
                    const b = tok.trim();
                    if (b && !seen.has(b)) { seen.add(b); buildings.push(b); }
                });
            });

            const out = {};
            columns.forEach(col => {
                if (col === BLDG_FIELD) {
                    out[col] = buildings.join("; ");
                } else if (col === COUNT_FIELD) {
                    out[col] = String(buildings.length);
                } else {
                    let val = "";
                    for (const r of ordered) { if (!isBlank(r[col])) { val = r[col]; break; } }
                    out[col] = val;
                }
            });

            const times = rows.map(r => parseFieldTimestamp(r["Date/timestamp"])).filter(t => !isNaN(t));
            out["Captures Merged"] = rows.length;
            out["First Captured"] = times.length ? fmt(new Date(Math.min(...times))) : "";
            out["Last Captured"] = times.length ? fmt(new Date(Math.max(...times))) : "";
            return out;
        };

        const orderNewestFirst = rows => rows
            .map((r, i) => ({ r, i, t: parseFieldTimestamp(r["Date/timestamp"]) }))
            .sort((a, b) => {
                const at = isNaN(a.t) ? -Infinity : a.t;
                const bt = isNaN(b.t) ? -Infinity : b.t;
                if (bt !== at) return bt - at;   // newest first
                return a.i - b.i;                // stable tie-break
            })
            .map(x => x.r);

        const merged = [];
        groups.forEach(rows => merged.push(buildRow(rows, orderNewestFirst(rows))));
        passthrough.forEach(item => merged.push(buildRow([item], [item])));
        return merged;
    }

    // Order export rows by physical line sequence: Feeder → DT → Upriser → LT Pole
    // No. This walks each DT starting from its upriser and follows the pole numbers
    // outward from the first pole connected to the DT (the order the line is walked
    // in the field), so the merged export reads as a clean sequence per the request.
    // Missing/non-numeric Upriser or Pole numbers sink within their DT group.
    function sortBySequence(rows) {
        const num = (v) => {
            const n = parseInt(String(v == null ? "" : v).replace(/[^\d]/g, ""), 10);
            return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
        };
        const str = (v) => String(v == null ? "" : v).trim().toLowerCase();
        rows.sort((a, b) => {
            const f = str(a.Feeder).localeCompare(str(b.Feeder));
            if (f) return f;
            const dt = str(a["DT Name"] || a["DT Number"]).localeCompare(str(b["DT Name"] || b["DT Number"]));
            if (dt) return dt;
            const u = num(a.UpriserNo) - num(b.UpriserNo);
            if (u) return u;
            const p = num(a["LT Pole No"]) - num(b["LT Pole No"]);
            if (p) return p;
            return str(a["Lt PoleSLRN"]).localeCompare(str(b["Lt PoleSLRN"])); // stable final tie-break
        });
        return rows;
    }

    // Build the cleaned, de-duplicated dataset from whatever is currently filtered.
    function getCleanExportData() {
        const cleaned = sortBySequence(mergeDuplicatesBySLRN(filteredData));
        const removed = filteredData.length - cleaned.length;
        if (removed > 0) {
            console.log(`[Export] Merged ${removed} duplicate capture(s) by LT Pole SLRN → ${cleaned.length} unique poles.`);
        }
        return cleaned;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  EXPORTS — professional Excel / CSV / PDF
    //  Every export draws from ONE analytics engine (computeReportStats) and
    //  ONE column schema (REGISTER_COLUMNS), so the workbook, the CSV and the
    //  PDF can never disagree with each other or with the on-screen KPIs.
    //  Simulated fields (Issue_Type) are deliberately never surfaced.
    // ══════════════════════════════════════════════════════════════════════

    // Curated, human-friendly column order for the pole register. Simulated
    // fields are excluded; two derived columns (Building Linked, Field Officer)
    // are added for quick filtering. `type: 'n'` cells are exported as real
    // numbers so Excel can sort/aggregate them.
    const REGISTER_COLUMNS = [
        { header: 'LT Pole SLRN', key: 'Lt PoleSLRN', type: 's', width: 16 },
        { header: 'LT Pole No', key: 'LT Pole No', type: 's', width: 11 },
        { header: 'LT Pole ID', key: 'LT Pole ID', type: 's', width: 11 },
        { header: 'Business Unit', key: 'Bussines Unit', type: 's', width: 14 },
        { header: 'Undertaking', key: 'Undertaking', type: 's', width: 15 },
        { header: 'Feeder', key: 'Feeder', type: 's', width: 26 },
        { header: 'DT Name', key: 'DT Name', type: 's', width: 34 },
        { header: 'DT Number', key: 'DT Number', type: 's', width: 13 },
        { header: 'Upriser No', key: 'UpriserNo', type: 'n', width: 10, fmt: '0' },
        { header: 'Pole Type', key: 'Type of Pole', type: 's', width: 12 },
        { header: 'Buildings Connected', key: 'No of Buildings Connected to the Pole', type: 'n', width: 13, fmt: '0' },
        { header: 'Building Linked', key: '__linked', type: 's', width: 12 },
        { header: 'Associated Building SLRN', key: 'Associated Buildings SLRN', type: 's', width: 22 },
        { header: 'Location / Landmark', key: 'Location address', type: 's', width: 30 },
        { header: 'Vendor', key: 'Vendor_Name', type: 's', width: 18 },
        { header: 'Field Officer', key: '__officer', type: 's', width: 20 },
        { header: 'Status', key: 'Status', type: 's', width: 12 },
        { header: 'Capture Date', key: 'Date/timestamp', type: 's', width: 16 },
        { header: 'Latitude', key: 'Latitude', type: 'n', width: 13, fmt: '0.000000' },
        { header: 'Longitude', key: 'Longitude', type: 'n', width: 13, fmt: '0.000000' },
    ];

    function registerCellValue(col, d) {
        if (col.key === '__linked') return String(d['Associated Buildings SLRN'] || '').trim() ? 'Yes' : 'No';
        if (col.key === '__officer') return getDisplayName(d['User']) || d['User'] || '';
        const v = d[col.key];
        return v == null ? '' : v;
    }

    // Cleaned (de-duplicated, sequence-sorted) register as {headers, rows[][]}.
    function buildRegisterMatrix() {
        const rows = getCleanExportData();
        const headers = REGISTER_COLUMNS.map(c => c.header);
        const matrix = rows.map(d => REGISTER_COLUMNS.map(c => registerCellValue(c, d)));
        return { headers, rows: matrix, columns: REGISTER_COLUMNS };
    }

    // Single source of truth for a DT's completion % and status bucket — used
    // by dtStats, the Excel DT sheet AND the PDF DT table so all three agree.
    // progress is null when the DT has no BOQ target (can't compute completion).
    function dtClassify(r) {
        const hasTarget = r.boqTotal > 0;
        const ratio = hasTarget ? r.actualTotal / r.boqTotal : 0;
        const progress = hasTarget ? +(ratio * 100).toFixed(1) : null;
        let status;
        if (r.actualTotal === 0) status = 'Not Started';
        else if (hasTarget && ratio >= 1) status = 'Completed';
        else if (hasTarget && ratio >= 0.9) status = 'Near Complete';
        else status = 'In Progress';
        return { progress, status, hasTarget };
    }

    // ── Report analytics — single source of truth for every headline number ──
    function computeReportStats() {
        const data = filteredData || [];
        const totalUnique = countUniquePoles(data);
        const rawCount = data.length;

        const vendorCounts = uniquePolesByGroupExclusive(data, d => d.Vendor_Name || 'Other');
        const vendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count, pct: totalUnique ? (count / totalUnique) * 100 : 0 }));

        const userCounts = uniquePolesByGroup(data, d => d.User);
        const officers = Object.entries(userCounts).sort((a, b) => b[1] - a[1])
            .map(([user, count]) => ({ user, name: getDisplayName(user) || user, count, pct: totalUnique ? (count / totalUnique) * 100 : 0 }));

        const linkage = buildingLinkage(data);
        const buildings = uniqueBuildings(data);

        // Exclusive assignment so the type counts sum to totalUnique — keeps the
        // donut wedges consistent with the printed share %.
        const poleTypeCounts = uniquePolesByGroupExclusive(data, d => (d['Type of Pole'] || 'Unknown').toUpperCase());
        const poleTypes = Object.entries(poleTypeCounts).sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type: type.charAt(0) + type.slice(1).toLowerCase(), count, pct: totalUnique ? (count / totalUnique) * 100 : 0 }));
        const dominantPole = poleTypes[0] || null;

        const coverage = {
            feeders: new Set(data.map(d => d.Feeder).filter(Boolean)).size,
            dts: new Set(data.map(d => d['DT Name']).filter(Boolean)).size,
            uts: new Set(data.map(d => d.Undertaking).filter(Boolean)).size,
            bus: new Set(data.map(d => d['Bussines Unit']).filter(Boolean)).size,
            officers: officers.length
        };

        // Unique poles per capture-day. Capture date is MM/DD/YYYY.
        const parseDay = (s) => { const m = String(s).split('/'); return m.length === 3 ? new Date(+m[2], +m[0] - 1, +m[1]).getTime() : 0; };
        const dayMap = {};
        data.forEach(d => {
            const day = String(d['Date/timestamp'] || '').split(' ')[0];
            if (!day) return;
            const s = poleSlrn(d); if (!s) return;
            (dayMap[day] = dayMap[day] || new Set()).add(s);
        });
        const dailyCounts = Object.entries(dayMap)
            .map(([date, set]) => ({ date, count: set.size, ts: parseDay(date) }))
            .sort((a, b) => a.ts - b.ts);
        // Run rate uses the SAME population as the denominator: dated unique
        // poles ÷ active dated days. Undated captures must not inflate it.
        const activeDays = dailyCounts.length;
        const datedTotal = dailyCounts.reduce((s, x) => s + x.count, 0);
        const runRate = activeDays ? datedTotal / activeDays : 0;
        const firstDate = dailyCounts[0]?.date || 'N/A';
        const lastDate = dailyCounts[dailyCounts.length - 1]?.date || 'N/A';
        const recent3 = dailyCounts.slice(-3), prev3 = dailyCounts.slice(-6, -3);
        const recentRate = recent3.length ? Math.round(recent3.reduce((s, x) => s + x.count, 0) / recent3.length) : 0;
        const prevRate = prev3.length ? Math.round(prev3.reduce((s, x) => s + x.count, 0) / prev3.length) : 0;
        const trendPct = prevRate > 0 ? Math.round(((recentRate - prevRate) / prevRate) * 100) : 0;
        const trending = trendPct > 5 ? 'accelerating' : trendPct < -5 ? 'decelerating' : 'holding steady';
        const TARGET_RATE = 50;
        const verdict = runRate >= TARGET_RATE ? 'on target' : runRate >= TARGET_RATE * 0.7 ? 'approaching target' : 'below target';

        // BOQ target scoped by the active feeder/DT filter (matches KPI cards).
        let scopedBoq = boqData || [];
        const fv = multiSelects.feederFilter?.getValues();
        if (fv && fv.length) scopedBoq = scopedBoq.filter(d => fv.includes(d['FEEDER NAME']));
        const dv = multiSelects.dtFilter?.getValues();
        if (dv && dv.length) scopedBoq = scopedBoq.filter(d => dv.includes(d['DT NAME']));
        const boqTarget = scopedBoq.reduce((s, d) => s + (parseInt(d['POLES Grand Total']) || 0), 0);
        // Uncapped so it matches the on-screen KPI card (which shows >100% on
        // over-capture); the visual gauge clamps its own bar width.
        const completionPct = boqTarget > 0 ? (totalUnique / boqTarget) * 100 : null;

        const dtRows = getEnhancedDTData().sort((a, b) => b.actualTotal - a.actualTotal);
        // Bucket via the shared classifier so the bars/summary/tables never disagree.
        const dtStats = {
            total: dtRows.length,
            completed: dtRows.filter(r => dtClassify(r).status === 'Completed').length,
            nearComplete: dtRows.filter(r => dtClassify(r).status === 'Near Complete').length,
            inProgress: dtRows.filter(r => dtClassify(r).status === 'In Progress').length,
            notStarted: dtRows.filter(r => dtClassify(r).status === 'Not Started').length
        };

        const activeFilterList = [];
        [['Vendor', 'vendorFilter'], ['Business Unit', 'buFilter'], ['Undertaking', 'utFilter'], ['Feeder', 'feederFilter'], ['DT', 'dtFilter'], ['Officer', 'userFilter'], ['Upriser', 'upriserFilter'], ['Pole Type', 'materialFilter'], ['Date', 'dateFilter']].forEach(([label, id]) => {
            const vals = multiSelects[id]?.getValues();
            if (vals && vals.length) activeFilterList.push({ label, value: vals.length > 3 ? `${vals.length} selected` : vals.join(', ') });
        });
        const filterText = activeFilterList.length ? activeFilterList.map(f => `${f.label}: ${f.value}`).join('   |   ') : 'No filters applied (all data)';

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        const kpiGet = (id) => (document.getElementById(id)?.textContent || '--').trim();
        const kpiCards = [
            ['Total Poles', kpiGet('kpi-boq-records'), kpiGet('kpi-act-records'), kpiGet('kpi-prog-records'), kpiGet('kpi-rem-records')],
            ['New Poles (Install)', kpiGet('kpi-boq-users'), kpiGet('kpi-act-users'), kpiGet('kpi-prog-users'), kpiGet('kpi-rem-users')],
            ['Feeders', kpiGet('kpi-boq-feeders'), kpiGet('kpi-act-feeders'), kpiGet('kpi-prog-feeders'), '—'],
            ['DTs', kpiGet('kpi-boq-dts'), kpiGet('kpi-act-dts'), kpiGet('kpi-prog-dts'), '—'],
            ['Building Linkage', '100%', linkage.pct.toFixed(1) + '%', linkage.pct.toFixed(1) + '%', linkage.unlinked.toLocaleString() + ' to tag'],
            ['Buildings Connected', '—', buildings.toLocaleString(), '—', '—']
        ];

        return {
            generatedAt: { dateStr, timeStr }, filterText, activeFilterList,
            totalUnique, rawCount, vendors, officers, linkage, buildings,
            poleTypes, dominantPole, coverage,
            velocity: { runRate, activeDays, firstDate, lastDate, recentRate, prevRate, trendPct, trending, verdict, targetRate: TARGET_RATE, dailyCounts },
            boq: { target: boqTarget, completionPct }, dtStats, dtRows, kpiCards
        };
    }

    // ── Excel styling toolkit (xlsx-js-style) ───────────────────────────────
    const XLC = {
        blue: '1E40AF', blueDk: '1E3A8A', blueLt: 'DBEAFE', white: 'FFFFFF',
        slate: '475569', ink: '1F2937', band: 'F1F5F9', bandBlue: 'EFF6FF',
        line: 'E2E8F0', headBorder: 'CBD5E1', green: '059669', amber: 'B45309', red: 'B91C1C'
    };
    const xlThin = (rgb) => ({ style: 'thin', color: { rgb: rgb || XLC.line } });
    const xlBorder = (rgb) => ({ top: xlThin(rgb), bottom: xlThin(rgb), left: xlThin(rgb), right: xlThin(rgb) });
    function xlStyle({ sz = 10, bold = false, italic = false, color = XLC.ink, align = 'left', fill, border = true, wrap = false } = {}) {
        const s = { font: { name: 'Calibri', sz, bold, italic, color: { rgb: color } }, alignment: { horizontal: align, vertical: 'center', wrapText: wrap } };
        if (fill) s.fill = { patternType: 'solid', fgColor: { rgb: fill } };
        if (border) s.border = xlBorder();
        return s;
    }
    const XLS = {
        title: { font: { name: 'Calibri', sz: 18, bold: true, color: { rgb: XLC.white } }, fill: { patternType: 'solid', fgColor: { rgb: XLC.blue } }, alignment: { horizontal: 'left', vertical: 'center' } },
        sub: { font: { name: 'Calibri', sz: 10, color: { rgb: XLC.blueLt } }, fill: { patternType: 'solid', fgColor: { rgb: XLC.blue } }, alignment: { horizontal: 'left', vertical: 'center' } },
        section: { font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: XLC.white } }, fill: { patternType: 'solid', fgColor: { rgb: XLC.blueDk } }, alignment: { horizontal: 'left', vertical: 'center' } },
        th: { font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: XLC.white } }, fill: { patternType: 'solid', fgColor: { rgb: XLC.blue } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: xlBorder(XLC.headBorder) }
    };

    // Build a styled worksheet from a matrix of primitives / {v,t,z,s} cells.
    function buildStyledSheet(XL, cells, opts = {}) {
        const aoa = cells.map(row => row.map(c => (c && typeof c === 'object') ? (c.v ?? '') : c));
        const ws = XL.utils.aoa_to_sheet(aoa);
        for (let r = 0; r < cells.length; r++) {
            for (let c = 0; c < cells[r].length; c++) {
                const cell = cells[r][c];
                if (cell && typeof cell === 'object') {
                    const ref = XL.utils.encode_cell({ r, c });
                    const o = ws[ref] || (ws[ref] = { t: 's', v: '' });
                    if (cell.v !== undefined) o.v = cell.v;
                    if (cell.t) o.t = cell.t;
                    if (cell.z) o.z = cell.z;
                    if (cell.s) o.s = cell.s;
                }
            }
        }
        if (opts.cols) ws['!cols'] = opts.cols;
        if (opts.merges) ws['!merges'] = opts.merges;
        if (opts.rows) ws['!rows'] = opts.rows;
        if (opts.autofilter) ws['!autofilter'] = { ref: opts.autofilter };
        return ws;
    }

    // A data sheet: title band + meta line + styled header + banded rows +
    // autofilter + tuned column widths. `columns` carry type/format/width.
    function makeDataSheet(XL, { sheetTitle, subtitle, columns, rows, totalRow }) {
        const ncol = columns.length;
        const cells = [];
        const bandRow = (v, s) => { const row = [{ v, t: 's', s }]; for (let i = 1; i < ncol; i++) row.push({ v: '', t: 's', s }); return row; };
        cells.push(bandRow(sheetTitle, XLS.title));
        cells.push(bandRow(subtitle, XLS.sub));
        cells.push(columns.map(c => ({ v: c.header, t: 's', s: XLS.th })));
        rows.forEach((row, ri) => {
            const band = ri % 2 === 1;
            cells.push(row.map((val, ci) => {
                const col = columns[ci];
                // Trim before the numeric test so a whitespace-only source cell
                // (Number(' ') === 0) stays blank instead of coercing to 0.
                const trimmed = val == null ? '' : String(val).trim();
                const isNum = col.type === 'n' && trimmed !== '' && isFinite(Number(trimmed));
                if (isNum) return { v: Number(trimmed), t: 'n', z: col.fmt || '#,##0', s: xlStyle({ align: 'right', fill: band ? XLC.band : undefined }) };
                return { v: val == null ? '' : String(val), t: 's', s: xlStyle({ align: col.align || 'left', fill: band ? XLC.band : undefined }) };
            }));
        });
        if (totalRow) {
            cells.push(totalRow.map((val, ci) => {
                const col = columns[ci];
                const trimmed = val == null ? '' : String(val).trim();
                const isNum = col.type === 'n' && trimmed !== '' && isFinite(Number(trimmed));
                const base = { bold: true, color: XLC.blueDk, fill: XLC.bandBlue };
                if (isNum) return { v: Number(trimmed), t: 'n', z: col.fmt || '#,##0', s: xlStyle({ ...base, align: 'right' }) };
                return { v: val == null ? '' : String(val), t: 's', s: xlStyle({ ...base, align: col.align || 'left' }) };
            }));
        }
        const headerRowIdx = 2;
        const lastRow = cells.length - 1;
        const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: ncol - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: ncol - 1 } }];
        const autofilter = XL.utils.encode_range({ s: { r: headerRowIdx, c: 0 }, e: { r: lastRow, c: ncol - 1 } });
        const rowHeights = [{ hpt: 26 }, { hpt: 16 }, { hpt: 22 }];
        // (Freeze panes are not written by the xlsx-js-style build — verified —
        // so we rely on the autofilter for column navigation instead.)
        return buildStyledSheet(XL, cells, { cols: columns.map(c => ({ wch: c.width || 14 })), merges, autofilter, rows: rowHeights });
    }

    function saveWorkbook(XL, wb, filename) {
        // xlsx-js-style writes an ArrayBuffer we hand to a Blob (works across
        // browsers and keeps our cell styles, unlike XLSX.writeFile on the
        // plain community build).
        const wbout = XL.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function downloadExcel() {
        if (!filteredData || filteredData.length === 0) { alert('No data available to download.'); return; }
        // Prefer the styling-capable build; fall back to the plain community
        // build (styles are silently ignored, but the data still exports).
        const XL = window.XLSXStyle || window.XLSX;
        const styled = !!window.XLSXStyle;
        const stats = computeReportStats();
        const reg = buildRegisterMatrix();
        const wb = XL.utils.book_new();
        wb.Props = {
            Title: 'IDB 2.0 Assets Tagging — Management Report',
            Subject: 'Asset Enumeration Programme',
            Author: 'IDB 2.0 Monitoring System',
            Company: 'Ikeja Electric',
            CreatedDate: new Date()
        };

        // ── Sheet 1: Executive Summary ──────────────────────────────────────
        const SUMMARY_COLS = 6;
        const sc = [];
        const rowN = (v, s) => { const r = [{ v, t: 's', s }]; for (let i = 1; i < SUMMARY_COLS; i++) r.push({ v: '', t: 's', s }); return r; };
        sc.push(rowN('IDB 2.0 ASSETS TAGGING — MANAGEMENT REPORT', XLS.title));
        sc.push(rowN('Ikeja Electric  ·  Asset Enumeration Programme', XLS.sub));
        sc.push(rowN(`Generated ${stats.generatedAt.dateStr} at ${stats.generatedAt.timeStr}`, xlStyle({ italic: true, color: XLC.slate, border: false })));
        sc.push(rowN(`Scope: ${stats.filterText}`, xlStyle({ italic: true, color: XLC.slate, border: false, wrap: true })));
        sc.push(rowN('', xlStyle({ border: false })));

        const secRow = (label) => sc.push(rowN(label, XLS.section));
        const th = (arr) => sc.push(arr.map((h, i) => ({ v: h, t: 's', s: XLS.th })).concat(Array.from({ length: SUMMARY_COLS - arr.length }, () => ({ v: '', t: 's', s: XLS.th }))));
        const bodyRow = (arr, opts = {}) => sc.push(arr.map((v, i) => {
            const isNum = typeof v === 'number';
            const st = xlStyle({ align: i === 0 ? 'left' : 'right', bold: opts.bold, fill: opts.fill, color: opts.color });
            return isNum ? { v, t: 'n', z: opts.fmt || '#,##0', s: st } : { v: v == null ? '' : String(v), t: 's', s: st };
        }).concat(Array.from({ length: SUMMARY_COLS - arr.length }, () => ({ v: '', t: 's', s: xlStyle({ fill: opts.fill }) }))));

        // KPI table
        secRow('KEY PERFORMANCE INDICATORS');
        th(['Metric', 'Expected', 'Actual', 'Progress', 'Remaining', '']);
        stats.kpiCards.forEach((r, i) => bodyRow([r[0], r[1], r[2], r[3], r[4], ''], { fill: i % 2 ? XLC.band : undefined }));
        sc.push(rowN('', xlStyle({ border: false })));

        // Vendor performance
        secRow('VENDOR PERFORMANCE');
        th(['Vendor', 'Assets Tagged', 'Share', '', '', '']);
        stats.vendors.forEach((v, i) => bodyRow([v.name, v.count, v.pct.toFixed(1) + '%', '', '', ''], { fill: i % 2 ? XLC.band : undefined }));
        bodyRow(['TOTAL', stats.totalUnique, '100%', '', '', ''], { bold: true, fill: XLC.bandBlue, color: XLC.blueDk });
        sc.push(rowN('', xlStyle({ border: false })));

        // DT status & coverage side matter
        secRow('DT STATUS & NETWORK COVERAGE');
        th(['Measure', 'Value', 'Measure', 'Value', '', '']);
        const dv2 = [
            ['DTs Completed', stats.dtStats.completed, 'Feeders Covered', stats.coverage.feeders],
            ['DTs Near Complete', stats.dtStats.nearComplete, 'DTs Covered', stats.coverage.dts],
            ['DTs In Progress', stats.dtStats.inProgress, 'Undertakings', stats.coverage.uts],
            ['DTs Not Started', stats.dtStats.notStarted, 'Business Units', stats.coverage.bus],
            ['DTs Tracked', stats.dtStats.total, 'Active Field Officers', stats.coverage.officers]
        ];
        dv2.forEach((r, i) => bodyRow([r[0], r[1], r[2], r[3], '', ''], { fill: i % 2 ? XLC.band : undefined }));
        sc.push(rowN('', xlStyle({ border: false })));

        // Data quality & velocity
        secRow('DATA QUALITY & DELIVERY');
        th(['Measure', 'Value', 'Measure', 'Value', '', '']);
        const qv = [
            ['Poles Captured (unique)', stats.totalUnique, 'Run Rate (poles/day)', Math.round(stats.velocity.runRate)],
            ['Building Linkage', stats.linkage.pct.toFixed(1) + '%', 'Rate Benchmark', stats.velocity.targetRate],
            ['Buildings Connected', stats.buildings, 'Delivery Status', stats.velocity.verdict],
            ['Poles Unlinked', stats.linkage.unlinked, 'Active Working Days', stats.velocity.activeDays],
            ['BOQ Completion', stats.boq.completionPct != null ? stats.boq.completionPct.toFixed(1) + '%' : 'N/A', 'Capture Window', `${stats.velocity.firstDate} → ${stats.velocity.lastDate}`]
        ];
        qv.forEach((r, i) => bodyRow([r[0], r[1], r[2], r[3], '', ''], { fill: i % 2 ? XLC.band : undefined }));
        sc.push(rowN('', xlStyle({ border: false })));

        // Key insights (narrative)
        secRow('KEY INSIGHTS');
        buildInsightLines(stats).forEach(line => {
            const r = [{ v: '•  ' + line, t: 's', s: xlStyle({ color: XLC.ink, border: false, wrap: true }) }];
            for (let i = 1; i < SUMMARY_COLS; i++) r.push({ v: '', t: 's', s: xlStyle({ border: false }) });
            sc.push(r);
        });
        sc.push(rowN('', xlStyle({ border: false })));

        // Notes & methodology — states the counting basis so the figures reconcile
        secRow('NOTES & METHODOLOGY');
        methodologyLines().forEach(line => {
            const r = [{ v: '•  ' + line, t: 's', s: xlStyle({ color: XLC.slate, border: false, wrap: true }) }];
            for (let i = 1; i < SUMMARY_COLS; i++) r.push({ v: '', t: 's', s: xlStyle({ border: false }) });
            sc.push(r);
        });

        const summaryWs = buildStyledSheet(XL, sc, {
            cols: [{ wch: 30 }, { wch: 18 }, { wch: 26 }, { wch: 18 }, { wch: 4 }, { wch: 4 }],
            merges: computeSummaryMerges(sc, SUMMARY_COLS),
            rows: [{ hpt: 30 }, { hpt: 16 }, { hpt: 14 }, { hpt: 16 }]
        });
        XL.utils.book_append_sheet(wb, summaryWs, 'Executive Summary');

        // ── Sheet 2: Pole Register ──────────────────────────────────────────
        const registerWs = makeDataSheet(XL, {
            sheetTitle: `POLE REGISTER  —  ${reg.rows.length.toLocaleString()} unique poles`,
            subtitle: `Generated ${stats.generatedAt.dateStr} ${stats.generatedAt.timeStr}   ·   ${stats.filterText}`,
            columns: REGISTER_COLUMNS,
            rows: reg.rows
        });
        XL.utils.book_append_sheet(wb, registerWs, 'Pole Register');

        // ── Sheet 3: Vendor Breakdown ───────────────────────────────────────
        const vendorWs = makeDataSheet(XL, {
            sheetTitle: 'VENDOR PERFORMANCE BREAKDOWN',
            subtitle: `${stats.vendors.length} vendors   ·   ${stats.totalUnique.toLocaleString()} unique poles`,
            columns: [
                { header: 'Vendor', type: 's', width: 26 },
                { header: 'Assets Tagged', type: 'n', width: 16, fmt: '#,##0' },
                { header: 'Share', type: 'n', width: 12, fmt: '0.0%' }
            ],
            rows: stats.vendors.map(v => [v.name, v.count, +(v.pct / 100).toFixed(4)]),
            totalRow: ['TOTAL', stats.totalUnique, 1]
        });
        XL.utils.book_append_sheet(wb, vendorWs, 'Vendor Breakdown');

        // ── Sheet 4: Field Officers ─────────────────────────────────────────
        const officersTotal = stats.officers.reduce((s, o) => s + o.count, 0);
        const officerWs = makeDataSheet(XL, {
            sheetTitle: 'FIELD OFFICER LEAGUE TABLE',
            subtitle: `${stats.officers.length} active officers   ·   ranked by unique poles tagged`,
            columns: [
                { header: 'Rank', type: 'n', width: 7, fmt: '0' },
                { header: 'Field Officer', type: 's', width: 24 },
                { header: 'Username', type: 's', width: 18 },
                { header: 'Assets Tagged', type: 'n', width: 15, fmt: '#,##0' },
                { header: 'Share', type: 'n', width: 11, fmt: '0.0%' }
            ],
            rows: stats.officers.map((o, i) => [i + 1, o.name, o.user, o.count, +(o.pct / 100).toFixed(4)]),
            totalRow: ['', 'TOTAL', '', officersTotal, stats.totalUnique ? +(officersTotal / stats.totalUnique).toFixed(4) : 1]
        });
        XL.utils.book_append_sheet(wb, officerWs, 'Field Officers');

        // ── Sheet 5: DT Performance ─────────────────────────────────────────
        const dtTot = stats.dtRows.reduce((a, r) => ({ exp: a.exp + r.boqTotal, act: a.act + r.actualTotal, conc: a.conc + r.concrete, wood: a.wood + r.wooden }), { exp: 0, act: 0, conc: 0, wood: 0 });
        const dtWs = makeDataSheet(XL, {
            sheetTitle: 'DISTRIBUTION TRANSFORMER PERFORMANCE',
            subtitle: `${stats.dtRows.length} DTs   ·   Expected vs Actual with completion status`,
            columns: [
                { header: 'DT Name', type: 's', width: 34 },
                { header: 'Feeder', type: 's', width: 26 },
                { header: 'Vendor', type: 's', width: 18 },
                { header: 'Expected', type: 'n', width: 11, fmt: '#,##0' },
                { header: 'Actual', type: 'n', width: 11, fmt: '#,##0' },
                { header: 'Concrete', type: 'n', width: 11, fmt: '#,##0' },
                { header: 'Wooden', type: 'n', width: 11, fmt: '#,##0' },
                { header: 'Progress', type: 'n', width: 12, fmt: '0.0%' },
                { header: 'Status', type: 's', width: 14 }
            ],
            rows: stats.dtRows.map(r => { const c = dtClassify(r); return [r.dtName, r.feeder, r.vendor, r.boqTotal, r.actualTotal, r.concrete, r.wooden, c.progress == null ? '' : +(c.progress / 100).toFixed(4), c.status]; }),
            totalRow: ['TOTAL', '', '', dtTot.exp, dtTot.act, dtTot.conc, dtTot.wood, dtTot.exp > 0 ? +(dtTot.act / dtTot.exp).toFixed(4) : '', '']
        });
        XL.utils.book_append_sheet(wb, dtWs, 'DT Performance');

        // ── Sheet 6: Business Unit Summary ──────────────────────────────────
        const buCounts = uniquePolesByGroup(filteredData, d => d['Bussines Unit'] || 'Unknown');
        const buRows = Object.entries(buCounts).sort((a, b) => b[1] - a[1])
            .map(([bu, c]) => [bu, c, stats.totalUnique ? +(c / stats.totalUnique).toFixed(4) : 0]);
        const buWs = makeDataSheet(XL, {
            sheetTitle: 'BUSINESS UNIT SUMMARY',
            subtitle: `${buRows.length} business unit${buRows.length > 1 ? 's' : ''}   ·   unique poles by BU`,
            columns: [
                { header: 'Business Unit', type: 's', width: 26 },
                { header: 'Unique Poles', type: 'n', width: 14, fmt: '#,##0' },
                { header: 'Share', type: 'n', width: 12, fmt: '0.0%' }
            ],
            rows: buRows,
            totalRow: ['TOTAL', stats.totalUnique, 1]
        });
        XL.utils.book_append_sheet(wb, buWs, 'Business Units');

        const fname = `IDB_Assets_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
        if (styled) saveWorkbook(XL, wb, fname);
        else XL.writeFile(wb, fname);
    }

    // Full-width merges for the summary sheet: merge only the banner/section/
    // insight rows (a single leading cell with the rest blank), never the
    // 2-column data tables.
    function computeSummaryMerges(cells, ncol) {
        const merges = [];
        cells.forEach((row, r) => {
            const lead = row[0];
            const leadVal = lead && typeof lead === 'object' ? lead.v : lead;
            // Merge full-width ONLY for single-lead-cell rows (title / section
            // band / insight line). The 2-column data tables carry values in
            // cols 1+, so they never match and keep their individual headers.
            const rest = row.slice(1).every(c => { const v = c && typeof c === 'object' ? c.v : c; return v === '' || v == null; });
            if (leadVal !== '' && leadVal != null && rest) merges.push({ s: { r, c: 0 }, e: { r, c: ncol - 1 } });
        });
        return merges;
    }

    // Shared methodology notes (Excel "Notes & Methodology" + PDF footnote) so
    // every headline figure states its counting basis and reconciles.
    function methodologyLines() {
        return [
            'Poles are counted by unique LT Pole SLRN — a pole captured more than once counts once.',
            'Only field-captured attributes are reported; simulated/diagnostic fields (e.g. pole condition) are deliberately excluded.',
            'Run Rate = dated unique poles ÷ active working days.  BOQ Completion = unique poles ÷ scoped BOQ target.',
            'Capture dates are MM/DD/YYYY. All figures reflect the dashboard filters active at the moment of export.'
        ];
    }

    // Shared narrative insight lines (used by Excel Key Insights + PDF).
    function buildInsightLines(stats) {
        const lines = [];
        const lead = stats.vendors[0];
        lines.push(`${stats.totalUnique.toLocaleString()} unique poles captured across ${stats.coverage.feeders} feeders, ${stats.coverage.dts} DTs and ${stats.coverage.bus} business unit${stats.coverage.bus > 1 ? 's' : ''} by ${stats.coverage.officers} field officers.`);
        if (lead) lines.push(`${lead.name} leads enumeration with ${lead.count.toLocaleString()} poles (${lead.pct.toFixed(1)}% of the total).`);
        lines.push(`Delivery is ${stats.velocity.verdict} at ${Math.round(stats.velocity.runRate)} poles/day (benchmark ${stats.velocity.targetRate}); the recent trend is ${stats.velocity.trending}${stats.velocity.trendPct ? ` (${stats.velocity.trendPct > 0 ? '+' : ''}${stats.velocity.trendPct}%)` : ''}.`);
        lines.push(`Building-SLRN linkage stands at ${stats.linkage.pct.toFixed(1)}% — ${stats.linkage.linked.toLocaleString()} of ${stats.linkage.total.toLocaleString()} poles linked, ${stats.linkage.unlinked.toLocaleString()} outstanding.`);
        if (stats.boq.completionPct != null) lines.push(`Overall BOQ completion is ${stats.boq.completionPct.toFixed(1)}% (${stats.totalUnique.toLocaleString()} of ${stats.boq.target.toLocaleString()} target poles).`);
        lines.push(`DT delivery: ${stats.dtStats.completed} completed, ${stats.dtStats.nearComplete} near complete, ${stats.dtStats.inProgress} in progress, ${stats.dtStats.notStarted} not started.`);
        if (stats.dominantPole) lines.push(`${stats.dominantPole.type} is the dominant pole type at ${stats.dominantPole.pct.toFixed(0)}% of captured assets.`);
        return lines;
    }

    function downloadCSV() {
        if (!filteredData || filteredData.length === 0) { alert('No data available to download.'); return; }
        const reg = buildRegisterMatrix();
        const esc = (v) => {
            let s = v == null ? '' : String(v);
            // Neutralise spreadsheet formula/DDE injection: a cell that starts
            // with = + - @ (or a control char) is prefixed with an apostrophe.
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            // Quote on comma, quote, CR or LF (a lone CR must not split a record).
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const lines = [reg.headers.map(esc).join(',')];
        reg.rows.forEach(row => lines.push(row.map(esc).join(',')));
        // UTF-8 BOM so Excel opens it with correct encoding.
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `IDB_Pole_Register_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /* =====================================================================
     * Chart theming (dark ↔ light). One source of truth for chart text/grid
     * colours, resolved from the active <html data-theme> at render time. Charts
     * are re-rendered whenever the theme changes (via updateDashboard), so no
     * chart definition needs to hardcode a theme-specific colour any more.
     * ===================================================================== */
    function chartTheme() {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        return {
            light,
            mode: light ? 'light' : 'dark',
            text: light ? '#1e293b' : '#fafafa',
            muted: light ? '#475569' : '#a0a0a0',
            grid: light ? 'rgba(15,23,42,0.12)' : 'rgba(255,255,255,0.08)'
        };
    }

    // Force theme-appropriate text/grid/annotation colours onto a Plotly layout
    // so each chart definition can keep its (dark-oriented) literals unchanged.
    function applyPlotlyTheme(layout) {
        const t = chartTheme();
        const L = layout || {};
        L.font = Object.assign({}, L.font, { color: t.text });
        if (L.title && typeof L.title === 'object') {
            L.title.font = Object.assign({}, L.title.font, { color: t.text });
        }
        // Only re-colour gridlines in LIGHT mode; leave each chart's original
        // dark-oriented gridcolor untouched so the dark theme is pixel-identical.
        if (t.light) {
            ['xaxis', 'yaxis', 'xaxis2', 'yaxis2'].forEach(ax => {
                const a = L[ax];
                if (a && typeof a === 'object' && 'gridcolor' in a) a.gridcolor = t.grid;
            });
        }
        if (Array.isArray(L.annotations)) {
            L.annotations.forEach(an => {
                // Only re-theme annotations that used the default near-white text;
                // leave deliberately-coloured callouts alone.
                if (an && an.font && (an.font.color === '#fafafa' || an.font.color === '#e4e5e7')) {
                    an.font = Object.assign({}, an.font, { color: t.text });
                }
            });
        }
        return L;
    }

    // Drop-in for Plotly.newPlot that applies the active theme first.
    function themedPlot(id, traces, layout, config) {
        return Plotly.newPlot(id, traces, applyPlotlyTheme(layout), config);
    }

    /* =====================================================================
     * New-Pole Template dropdown: Download / Upload-filled-template.
     * Uploading a filled template parses it in-browser (SheetJS), maps its
     * columns to the dashboard's field-data schema, restricts it to the
     * feeders allowed by dashboard-config.js (window.IDB_CONFIG), upserts the
     * rows into globalData by "Lt PoleSLRN", and re-renders every view. This
     * is a SESSION PREVIEW — it clears on refresh and never touches the
     * canonical Convex/Git dataset. "Clear uploaded preview" restores the
     * pre-upload data.
     * ===================================================================== */

    // Maps a normalised template header (row-7 labels, whitespace collapsed +
    // lower-cased) to the destination key used across the dashboard.
    const TEMPLATE_HEADER_MAP = {
        'business unit': 'Bussines Unit',
        'undertaking': 'Undertaking',
        'feeder': 'Feeder',
        'dt name': 'DT Name',
        'dt number': 'DT Number',
        'upriser no': 'UpriserNo',
        'pole category': 'Pole Category',
        'type of pole': 'Type of Pole',
        'no. of buildings connected': 'No of Buildings Connected to the Pole',
        'no of buildings connected': 'No of Buildings Connected to the Pole',
        'reason for installation': 'Reason for Installation',
        'location address / landmark': 'Location address',
        'location address': 'Location address',
        'latitude': 'Latitude',
        'longitude': 'Longitude',
        'date installed': 'Date Installed',
        'installed by (contractor)': 'Installed By',
        'installed by': 'Installed By',
        'work order / project ref': 'Work Order',
        'remarks': 'Remarks',
        'lt pole slrn': 'Lt PoleSLRN',
        'lt pole no': 'LT Pole No',
        'associated buildings slrn': 'Associated Buildings SLRN',
        'captured by': 'User',
        'capture date': 'Date/timestamp',
        'status': 'Status'
    };

    let templateOriginalSnapshot = null; // pristine globalData before any upload

    const normHeader = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

    function formatTimestampNow() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ── Dropdown open/close ──
    const templateDropdown = document.getElementById('templateDropdown');
    const templateToggle = document.getElementById('templateDropdownToggle');
    const templateMenu = document.getElementById('templateDropdownMenu');
    const templateUploadItem = document.getElementById('templateUploadItem');
    const templateUploadInput = document.getElementById('templateUploadInput');
    const templateClearItem = document.getElementById('templateClearItem');
    const templateDownloadItem = document.getElementById('templateDownloadItem');
    const templatePreviewBadge = document.getElementById('templatePreviewBadge');

    function openTemplateMenu() {
        if (!templateDropdown || !templateMenu) return;
        templateDropdown.classList.add('open');
        templateMenu.hidden = false;
        templateToggle.setAttribute('aria-expanded', 'true');
    }
    function closeTemplateMenu() {
        if (!templateDropdown || !templateMenu) return;
        templateDropdown.classList.remove('open');
        templateMenu.hidden = true;
        templateToggle.setAttribute('aria-expanded', 'false');
    }
    function toggleTemplateMenu() {
        if (templateMenu && templateMenu.hidden) openTemplateMenu();
        else closeTemplateMenu();
    }

    if (templateToggle) {
        templateToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTemplateMenu();
        });
    }
    if (templateDownloadItem) {
        templateDownloadItem.addEventListener('click', () => closeTemplateMenu());
    }
    document.addEventListener('click', (e) => {
        if (templateDropdown && !templateDropdown.contains(e.target)) closeTemplateMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeTemplateMenu();
    });

    if (templateUploadItem && templateUploadInput) {
        templateUploadItem.addEventListener('click', () => {
            closeTemplateMenu();
            templateUploadInput.value = ''; // allow re-selecting the same file
            templateUploadInput.click();
        });
        templateUploadInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleTemplateUpload(file);
        });
    }
    if (templateClearItem) {
        templateClearItem.addEventListener('click', () => {
            closeTemplateMenu();
            clearTemplatePreview();
        });
    }

    function refreshPreviewBadge() {
        if (!templatePreviewBadge) return;
        const n = globalData.filter(r => r && r.__source === 'template-upload').length;
        if (n > 0) {
            templatePreviewBadge.textContent = '+' + n;
            templatePreviewBadge.hidden = false;
            templatePreviewBadge.title = n + ' uploaded pole(s), shared with all users';
            // Only admins can remove shared uploads, so only they see the control.
            if (templateClearItem) templateClearItem.hidden = !isAdminUser();
        } else {
            templatePreviewBadge.hidden = true;
            if (templateClearItem) templateClearItem.hidden = true;
        }
    }

    function rerenderAfterDataChange(previewNote) {
        detectDuplicateSLRNs(globalData);
        buildAssetIndex(globalData);   // uploaded poles bring their own SLRNs
        populateFilters();     // rebuild filter option lists (new feeders/DTs/users)
        applyFilters();        // recompute filteredData + updateDashboard()
        updateExecutiveSummary();
        refreshPreviewBadge();
        const stamp = `Last Updated: ${new Date().toLocaleTimeString()}${previewNote ? ' · ' + previewNote : ''}`;
        document.querySelectorAll('.last-updated').forEach(el => { el.textContent = stamp; });
    }

    // ── Shared uploaded poles (Convex table "pole_uploads") ──────────────
    // Uploaded poles live in the shared backend so EVERY viewer sees them.
    // Reads are public; publishing and clearing are admin-only (enforced on the
    // server in poleUploads.ts). There is no per-device copy — the Convex list
    // is the single source of truth, merged into globalData client-side.

    // Upsert a batch of already-normalised upload records into globalData by
    // Lt PoleSLRN. Snapshots the pristine (non-upload) dataset once so a reset
    // can revert the in-memory view. Returns {added, updated, addedNoKey}.
    function upsertUploadRecords(records) {
        if (!templateOriginalSnapshot) {
            templateOriginalSnapshot = globalData
                .filter(r => !(r && r.__source === 'template-upload'))
                .map(r => ({ ...r }));
        }
        const bySlrn = new Map();
        globalData.forEach((r, idx) => {
            const k = String((r && r['Lt PoleSLRN']) || '').trim().toLowerCase();
            if (k) bySlrn.set(k, idx);
        });
        let added = 0, updated = 0, addedNoKey = 0;
        records.forEach(rec => {
            if (rec && rec.__source !== 'template-upload') rec.__source = 'template-upload';
            const k = String(rec['Lt PoleSLRN'] || '').trim().toLowerCase();
            if (k && bySlrn.has(k)) { globalData[bySlrn.get(k)] = rec; updated++; }
            else if (k) { bySlrn.set(k, globalData.length); globalData.push(rec); added++; }
            else { globalData.push(rec); addedNoKey++; }
        });
        return { added, updated, addedNoKey };
    }

    // Merge shared uploaded poles (from Convex) into globalData, scoped to this
    // dashboard's allowed feeders. Returns the count applied.
    function applySharedUploads(records) {
        let ups = Array.isArray(records) ? records.slice() : [];
        if (!ups.length) return 0;
        const allowed = (window.IDB_CONFIG && window.IDB_CONFIG.allowedFeeders) || null;
        if (Array.isArray(allowed) && allowed.length) {
            const allowSet = new Set(allowed.map(f => f.trim().toLowerCase()));
            ups = ups.filter(r => allowSet.has(String((r && r.Feeder) || '').trim().toLowerCase()));
        }
        if (!ups.length) return 0;
        upsertUploadRecords(ups);
        return ups.length;
    }

    // Re-fetch the shared list from Convex, rebuild globalData from the pristine
    // base + shared uploads, and re-render. Keeps every client in sync after a
    // publish/clear (including removals made elsewhere).
    function reloadSharedUploads(note) {
        if (!(window.IDB && IDB.query)) return Promise.resolve(0);
        return IDB.query('poleUploads:list')
            .catch(() => [])
            .then(records => {
                if (templateOriginalSnapshot) {
                    globalData = templateOriginalSnapshot.map(r => ({ ...r }));
                    templateOriginalSnapshot = null;
                } else {
                    globalData = globalData.filter(r => !(r && r.__source === 'template-upload'));
                }
                const n = applySharedUploads(records);
                rerenderAfterDataChange(note || (n ? 'shared uploads active' : ''));
                return n;
            });
    }

    function currentUser() {
        try { return (IDB.auth && IDB.auth.getSession() || {}).user || null; } catch (e) { return null; }
    }
    function isAdminUser() {
        const u = currentUser();
        return !!(u && u.role === 'admin');
    }

    // Publish records to Convex in chunks (admin only). Returns summed counts.
    function publishUploadsToConvex(token, records) {
        const CHUNK = 200;
        const totals = { added: 0, updated: 0, pending: 0 };
        let i = 0;
        function next() {
            if (i >= records.length) return Promise.resolve(totals);
            const batch = records.slice(i, i + CHUNK);
            i += CHUNK;
            return IDB.mutation('poleUploads:addMany', { token: token, records: batch })
                .then(res => {
                    if (res) {
                        totals.added += res.added || 0;
                        totals.updated += res.updated || 0;
                        totals.pending += res.pending || 0;
                    }
                    return next();
                });
        }
        return next();
    }

    // Admin only: remove ALL shared uploaded poles for everyone.
    function clearTemplatePreview() {
        const token = IDB.auth && IDB.auth.getToken && IDB.auth.getToken();
        if (!token || !currentUser()) {
            showTemplateResult({ error: 'Please sign in as an administrator to remove uploaded poles.' });
            return;
        }
        if (!isAdminUser()) {
            showTemplateResult({ error: 'Only administrators can remove uploaded poles.' });
            return;
        }
        if (!window.confirm('Remove ALL uploaded poles for everyone? This cannot be undone.')) return;
        IDB.mutation('poleUploads:clearAll', { token: token })
            .then(res => reloadSharedUploads('uploaded poles removed')
                .then(() => showTemplateResult({ cleared: true, removed: res && res.removed })))
            .catch(err => showTemplateResult({ error: (err && err.message) || 'Could not remove uploaded poles.' }));
    }

    function handleTemplateUpload(file) {
        if (typeof XLSX === 'undefined') {
            showTemplateResult({ error: 'The spreadsheet reader (SheetJS) failed to load. Check your connection and reload the page.' });
            return;
        }
        // Publishing changes what every user sees — admins only.
        if (!isAdminUser()) {
            showTemplateResult({ error: 'Only administrators can publish uploaded poles to the dashboard. Please sign in with an admin account.' });
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => showTemplateResult({ error: 'Could not read the file. Please try again.' });
        reader.onload = (ev) => {
            let wb;
            try {
                wb = XLSX.read(ev.target.result, { type: 'array' });
            } catch (err) {
                showTemplateResult({ error: 'That file is not a valid Excel workbook (.xlsx).' });
                return;
            }
            const sheetName = wb.SheetNames.find(n => /new pole/i.test(n)) || wb.SheetNames[0];
            const ws = wb.Sheets[sheetName];
            if (!ws) { showTemplateResult({ error: 'The workbook has no readable sheet.' }); return; }

            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });

            // Locate the header row (row 7 in the shipped template).
            const headerIdx = rows.findIndex(r =>
                Array.isArray(r) && (
                    r.some(c => normHeader(c) === 'lt pole slrn') ||
                    (r.some(c => normHeader(c) === 'business unit') && r.some(c => normHeader(c) === 'feeder'))
                )
            );
            if (headerIdx === -1) {
                showTemplateResult({ error: "This doesn't look like the New-Pole Installation template — its header row (Business Unit, Feeder, LT Pole SLRN …) wasn't found. Please use the downloaded template." });
                return;
            }

            const headerRow = rows[headerIdx];
            const colToKey = {};
            headerRow.forEach((h, i) => {
                const key = TEMPLATE_HEADER_MAP[normHeader(h)];
                if (key) colToKey[i] = key;
            });

            // Parse data rows below the header.
            const parsed = [];
            let blankSkipped = 0, exampleSkipped = 0, noFeederSkipped = 0;
            for (let ri = headerIdx + 1; ri < rows.length; ri++) {
                const row = rows[ri];
                if (!Array.isArray(row)) continue;
                const rec = {};
                Object.keys(colToKey).forEach(ci => {
                    let val = row[ci];
                    if (val == null) val = '';
                    rec[colToKey[ci]] = (typeof val === 'string') ? val.trim() : val;
                });

                const slrn = String(rec['Lt PoleSLRN'] || '').trim();
                const feeder = String(rec['Feeder'] || '').trim();
                const lat = String(rec['Latitude'] || '').trim();
                const lng = String(rec['Longitude'] || '').trim();
                const remarks = String(rec['Remarks'] || '').toLowerCase();

                if (remarks.indexOf('example row') !== -1) { exampleSkipped++; continue; }
                // Fully blank data row (e.g. the pre-numbered S/N rows) → skip.
                if (!slrn && !feeder && !lat && !lng &&
                    !String(rec['DT Name'] || '').trim() && !String(rec['DT Number'] || '').trim()) {
                    blankSkipped++; continue;
                }
                // A record must at least name a feeder so it can be scoped.
                if (!feeder) { noFeederSkipped++; continue; }

                // Complete to the dashboard's field-data schema.
                rec['Bussines Unit'] = String(rec['Bussines Unit'] || '').trim() || 'SHOMOLU';
                rec['LT Pole ID'] = String(rec['LT Pole ID'] || rec['LT Pole No'] || '').trim();
                if (!String(rec['Pole Category'] || '').trim()) rec['Pole Category'] = 'New Install';
                if (!String(rec['Date/timestamp'] || '').trim()) {
                    rec['Date/timestamp'] = String(rec['Date Installed'] || '').trim() || formatTimestampNow();
                }
                if (!String(rec['User'] || '').trim()) rec['User'] = String(rec['Installed By'] || '').trim() || 'Template Upload';
                rec.Vendor_Name = inferVendor(rec['User']);
                // A brand-new pole is in good condition. Keep "Reason for Installation"
                // as its own field — do NOT fold it into Issue_Type, which drives the
                // good/bad split (a blank Issue_Type would otherwise count as a defect).
                if (!rec.Issue_Type) rec.Issue_Type = 'Good Condition';

                // GIS-capture gate: a pole is only "captured / complete" once GIS has
                // assigned it an LT Pole SLRN (the template's FOR-GIS-USE-ONLY field,
                // "filled on field capture"). Until then it is installed-but-pending and
                // must NOT count toward completion / new-pole KPIs. The dashboard already
                // enforces this — every Actual count keys on the pole SLRN — so a pending
                // pole (no SLRN) is shown but never counted. Reflect that in Status too
                // instead of blindly defaulting to COMPLETE.
                var _uploadedStatus = String(rec['Status'] || '').trim();
                rec['__gisCaptured'] = !!slrn;
                rec['Status'] = _uploadedStatus || (slrn ? 'COMPLETE' : 'PENDING CAPTURE');
                rec.__source = 'template-upload';

                parsed.push(rec);
            }

            if (!parsed.length) {
                showTemplateResult({
                    error: 'No filled pole rows were found in the template. Fill in at least the Feeder and location details, then upload again.',
                    detail: { blankSkipped, exampleSkipped, noFeederSkipped }
                });
                return;
            }

            // Apply the per-dashboard feeder scope ("the configuration").
            const allowed = (window.IDB_CONFIG && window.IDB_CONFIG.allowedFeeders) || null;
            let outOfScope = 0;
            let scoped = parsed;
            if (Array.isArray(allowed) && allowed.length) {
                const allowSet = new Set(allowed.map(f => f.trim().toLowerCase()));
                scoped = parsed.filter(r => {
                    const ok = allowSet.has(String(r.Feeder || '').trim().toLowerCase());
                    if (!ok) outOfScope++;
                    return ok;
                });
            }

            if (!scoped.length) {
                showTemplateResult({
                    error: `All ${parsed.length} pole(s) in the file are on feeders outside this dashboard's scope (${(allowed || []).length} approved feeders), so nothing was added.`,
                    detail: { outOfScope }
                });
                return;
            }

            // Publish to the shared Convex store (admin only) so every viewer
            // sees these poles. The server is authoritative; we also fail fast
            // in the UI with a clear message.
            const token = IDB.auth && IDB.auth.getToken && IDB.auth.getToken();
            if (!token || !isAdminUser()) {
                showTemplateResult({ error: 'Only administrators can publish uploaded poles to the dashboard.' });
                return;
            }
            publishUploadsToConvex(token, scoped)
                .then(t => reloadSharedUploads('upload published').then(() => {
                    showTemplateResult({
                        title: 'Template published',
                        fileName: file.name,
                        added: t.added, updated: t.updated, addedNoKey: t.pending,
                        outOfScope: outOfScope,
                        blankSkipped: blankSkipped, exampleSkipped: exampleSkipped, noFeederSkipped: noFeederSkipped
                    });
                }))
                .catch(err => showTemplateResult({ error: (err && err.message) || 'Could not publish uploaded poles. Please try again.' }));
        };
        reader.readAsArrayBuffer(file);
    }

    // ── Self-contained result dialog (no external CSS) ──
    function showTemplateResult(r) {
        const existing = document.getElementById('tpl-result-overlay');
        if (existing) existing.parentNode.removeChild(existing);

        if (!document.getElementById('tpl-result-style')) {
            const st = document.createElement('style');
            st.id = 'tpl-result-style';
            st.textContent =
                "#tpl-result-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100001;padding:1rem;font-family:'Inter',system-ui,-apple-system,sans-serif}" +
                "#tpl-result{width:100%;max-width:420px;background:#161b22;color:#e6edf3;border:1px solid #2b3340;border-radius:14px;padding:1.4rem;box-shadow:0 25px 60px -20px rgba(0,0,0,.7)}" +
                "#tpl-result h3{margin:0 0 .2rem;font-size:1.1rem;display:flex;align-items:center;gap:.5rem}" +
                "#tpl-result p.sub{margin:.1rem 0 1rem;font-size:.82rem;color:#8b949e;word-break:break-word}" +
                "#tpl-result ul{list-style:none;margin:0 0 .4rem;padding:0}" +
                "#tpl-result li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem .1rem;border-bottom:1px solid #21262d;font-size:.88rem}" +
                "#tpl-result li:last-child{border-bottom:none}" +
                "#tpl-result li .v{font-weight:700}" +
                "#tpl-result li.pos .v{color:#7ee787}#tpl-result li.upd .v{color:#79c0ff}#tpl-result li.warn .v{color:#f0b849}" +
                "#tpl-result .note{margin-top:.9rem;font-size:.76rem;color:#8b949e;line-height:1.5;background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:.6rem .7rem}" +
                "#tpl-result .err{font-size:.9rem;color:#ffb3b3;line-height:1.55;margin:.2rem 0 .4rem}" +
                "#tpl-result .tpl-actions{display:flex;justify-content:flex-end;margin-top:1.1rem}" +
                "#tpl-result button{padding:.55rem 1.1rem;border-radius:8px;font-weight:600;font-size:.85rem;cursor:pointer;border:1px solid transparent;background:#8b5cf6;color:#fff}" +
                "#tpl-result button:hover{background:#7c3aed}";
            document.head.appendChild(st);
        }

        const rowLi = (label, val, cls) =>
            (val && val > 0) ? `<li class="${cls || ''}"><span>${label}</span><span class="v">${val}</span></li>` : '';

        let body;
        if (r.error) {
            body =
                '<h3>⚠️ Couldn\'t apply template</h3>' +
                (r.fileName ? `<p class="sub">${r.fileName}</p>` : '') +
                `<div class="err">${r.error}</div>`;
        } else if (r.cleared) {
            body =
                '<h3>↺ Uploaded poles removed</h3>' +
                `<p class="sub">Removed ${r.removed || 0} uploaded pole(s) for all users. The dashboard is back to the official dataset.</p>`;
        } else {
            const scopeNote = (typeof window !== 'undefined' && window.IDB_CONFIG && window.IDB_CONFIG.variant)
                ? window.IDB_CONFIG.variant.toUpperCase() : '';
            body =
                '<h3>✅ Template published</h3>' +
                (r.fileName ? `<p class="sub">${r.fileName}${scopeNote ? ' · ' + scopeNote + ' scope' : ''}</p>` : '') +
                '<ul>' +
                rowLi('Captured poles added (counted)', r.added, 'pos') +
                rowLi('Captured poles updated', r.updated, 'upd') +
                rowLi('Installed — awaiting GIS capture', r.addedNoKey, 'warn') +
                rowLi('Skipped — outside feeder scope', r.outOfScope, 'warn') +
                rowLi('Skipped — no feeder given', r.noFeederSkipped, 'warn') +
                '</ul>' +
                '<div class="note"><strong>Published to everyone</strong> — all users now see these poles (they persist across refreshes until an admin removes them). A pole counts toward completion / new-pole KPIs only once GIS assigns it an <strong>LT&nbsp;Pole&nbsp;SLRN</strong>; rows still <em>awaiting GIS capture</em> are shown but not counted. The official weekly dataset is untouched.</div>';
        }

        const ov = document.createElement('div');
        ov.id = 'tpl-result-overlay';
        ov.innerHTML =
            '<div id="tpl-result" role="dialog" aria-modal="true" aria-label="Template upload result">' +
            body +
            '<div class="tpl-actions"><button type="button" id="tplResultOk">Done</button></div></div>';
        document.body.appendChild(ov);
        const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
        document.getElementById('tplResultOk').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    }


    /* =====================================================================
     * Update Dashboard Data (JSON) — ADMIN ONLY.
     * Lets an administrator replace one of the dashboard's canonical data
     * files by uploading a JSON file:
     *   • Field captures  -> converted_data_latest.json
     *   • BOQ targets     -> BOQ-IDB.json
     * The file is validated in-browser, then POSTed to the admin-only Convex
     * endpoint (/admin/upload-asset), which stores it in the shared backend
     * and serves it to EVERY viewer. Writes are admin-only — enforced on the
     * Convex server (convex/http.ts), not just in this UI. After a successful
     * upload the dashboard reloads its data through the SAME pipeline, so this
     * dashboard's own configuration (the per-variant feeder allowlist in
     * dashboard-config.js) is re-applied and every KPI, chart, filter and the
     * map re-render against the new data — no page refresh needed.
     * ===================================================================== */
    const JSON_DATA_ASSETS = {
        field: { name: 'converted_data_latest.json', label: 'field capture data', feederKey: 'Feeder' },
        boq:   { name: 'BOQ-IDB.json',               label: 'BOQ targets',        feederKey: 'FEEDER NAME' }
    };

    const jsonUploadDropdown  = document.getElementById('jsonUploadDropdown');
    const jsonUploadToggle    = document.getElementById('jsonUploadToggle');
    const jsonUploadMenu      = document.getElementById('jsonUploadMenu');
    const jsonUploadInput     = document.getElementById('jsonUploadInput');
    const jsonUploadFieldItem = document.getElementById('jsonUploadFieldItem');
    const jsonUploadBoqItem   = document.getElementById('jsonUploadBoqItem');
    let   jsonUploadTarget    = 'field';

    function jsonEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function openJsonMenu() {
        if (!jsonUploadDropdown || !jsonUploadMenu) return;
        jsonUploadDropdown.classList.add('open');
        jsonUploadMenu.hidden = false;
        if (jsonUploadToggle) jsonUploadToggle.setAttribute('aria-expanded', 'true');
    }
    function closeJsonMenu() {
        if (!jsonUploadDropdown || !jsonUploadMenu) return;
        jsonUploadDropdown.classList.remove('open');
        jsonUploadMenu.hidden = true;
        if (jsonUploadToggle) jsonUploadToggle.setAttribute('aria-expanded', 'false');
    }
    function toggleJsonMenu() {
        if (jsonUploadMenu && jsonUploadMenu.hidden) openJsonMenu();
        else closeJsonMenu();
    }

    // Reveal the control for administrators only. The Convex server enforces
    // admin on every write, so this is a UX gate, not the security boundary.
    // NOTE: toggle inline display (not the [hidden] attribute) because
    // .template-dropdown sets `display:inline-flex`, which would override a bare
    // [hidden] and leave the control visible to viewers.
    function refreshJsonUploadVisibility() {
        if (!jsonUploadDropdown) return;
        const show = isAdminUser();
        jsonUploadDropdown.style.display = show ? '' : 'none';
        if (!show) closeJsonMenu();
    }

    if (jsonUploadToggle) {
        jsonUploadToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleJsonMenu(); });
    }
    document.addEventListener('click', (e) => {
        if (jsonUploadDropdown && !jsonUploadDropdown.contains(e.target)) closeJsonMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeJsonMenu(); });

    function beginJsonUpload(target) {
        jsonUploadTarget = (target === 'boq') ? 'boq' : 'field';
        closeJsonMenu();
        if (!isAdminUser()) {
            showJsonResult({ error: 'Only administrators can update the dashboard data. Please sign in with an admin account.' });
            return;
        }
        if (jsonUploadInput) { jsonUploadInput.value = ''; jsonUploadInput.click(); }
    }
    if (jsonUploadFieldItem) jsonUploadFieldItem.addEventListener('click', () => beginJsonUpload('field'));
    if (jsonUploadBoqItem)   jsonUploadBoqItem.addEventListener('click', () => beginJsonUpload('boq'));
    if (jsonUploadInput) {
        jsonUploadInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleJsonDatasetUpload(file, jsonUploadTarget);
        });
    }

    // Reveal for admins now (from the cached session) and again once the server
    // confirms the role (covers a session whose cached role is stale).
    refreshJsonUploadVisibility();
    try {
        if (window.IDB && IDB.auth && IDB.auth.me) {
            IDB.auth.me().then(refreshJsonUploadVisibility).catch(() => {});
        }
    } catch (e) {}

    // Read + validate a JSON dataset file, confirm with the admin, then publish.
    function handleJsonDatasetUpload(file, targetKey) {
        const asset = JSON_DATA_ASSETS[targetKey] || JSON_DATA_ASSETS.field;
        if (!isAdminUser()) {
            showJsonResult({ error: 'Only administrators can update the dashboard data.' });
            return;
        }
        const token = (window.IDB && IDB.auth && IDB.auth.getToken && IDB.auth.getToken()) || null;
        if (!token) {
            showJsonResult({ error: 'Your session has expired. Please sign in again as an administrator.' });
            return;
        }
        if (!/\.json$/i.test(file.name) && (!file.type || file.type.indexOf('json') === -1)) {
            showJsonResult({ error: 'Please choose a .json file.' });
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => showJsonResult({ error: 'Could not read the file. Please try again.' });
        reader.onload = (ev) => {
            const text = String((ev.target && ev.target.result) || '');
            if (!text.trim()) { showJsonResult({ error: 'The file is empty.' }); return; }
            let parsed;
            try { parsed = JSON.parse(text); }
            catch (err) { showJsonResult({ error: 'That file is not valid JSON. Export the data as a .json file and try again.' }); return; }
            // Same unwrap the loader uses: bare array, or {"Sheet2":[...]} etc.
            let records = Array.isArray(parsed) ? parsed
                : (parsed && typeof parsed === 'object'
                    ? (parsed.Sheet2 || parsed.Sheet1 || Object.values(parsed).find(Array.isArray) || [])
                    : []);
            if (!Array.isArray(records) || !records.length) {
                showJsonResult({ error: 'No records found. The JSON should be an array of row objects (or an object whose value is such an array).' });
                return;
            }
            // How many rows fall inside THIS dashboard's feeder scope ("the
            // configuration")? Surface it so the admin sees how much of the file
            // this particular dashboard will actually display.
            const allowed = (window.IDB_CONFIG && window.IDB_CONFIG.allowedFeeders) || null;
            const scoped = Array.isArray(allowed) && !!allowed.length;
            let inScope = records.length;
            if (scoped) {
                const allowSet = new Set(allowed.map(f => String(f).trim().toLowerCase()));
                inScope = records.filter(r => allowSet.has(String((r && r[asset.feederKey]) || '').trim().toLowerCase())).length;
            }
            confirmJsonUpload({ asset: asset, fileName: file.name, total: records.length, inScope: inScope, scoped: scoped }, () => {
                publishJsonAsset(token, asset.name, text)
                    .then(res => loadDashboardData({ reapplyFilters: true }).then(() => showJsonResult({
                        ok: true, asset: asset, fileName: file.name,
                        total: (res && res.records != null) ? res.records : records.length,
                        inScope: inScope, scoped: scoped
                    })))
                    .catch(err => showJsonResult({ error: (err && err.message) || 'Could not update the dashboard data. Please try again.' }));
            });
        };
        reader.readAsText(file);
    }

    // POST the raw JSON body to the admin-only Convex upload endpoint.
    function publishJsonAsset(token, name, bodyText) {
        const site = (window.IDB && IDB.SITE_URL) || '';
        if (!site) return Promise.reject(new Error('The backend URL is unavailable, so the upload cannot be sent.'));
        return fetch(site + '/admin/upload-asset?name=' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: bodyText
        }).then(r => r.json().catch(() => ({})).then(body => {
            if (!r.ok || !body || body.ok === false) {
                let msg = body && body.error;
                if (!msg) {
                    msg = (r.status === 404 || r.status === 405)
                        ? 'The data-upload endpoint is not deployed yet. Deploy the Convex backend (npx convex deploy) to enable JSON uploads.'
                        : ('Upload failed (HTTP ' + r.status + ').');
                }
                throw new Error(msg);
            }
            return body;
        }));
    }

    // ── Self-contained confirm / result dialogs (no external CSS) ──
    function ensureJsonDialogStyle() {
        if (document.getElementById('json-dlg-style')) return;
        const st = document.createElement('style');
        st.id = 'json-dlg-style';
        st.textContent =
            "#json-dlg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100001;padding:1rem;font-family:'Inter',system-ui,-apple-system,sans-serif}" +
            "#json-dlg{width:100%;max-width:440px;background:#161b22;color:#e6edf3;border:1px solid #2b3340;border-radius:14px;padding:1.4rem;box-shadow:0 25px 60px -20px rgba(0,0,0,.7)}" +
            "#json-dlg h3{margin:0 0 .2rem;font-size:1.1rem;display:flex;align-items:center;gap:.5rem}" +
            "#json-dlg p.sub{margin:.1rem 0 1rem;font-size:.82rem;color:#8b949e;word-break:break-word}" +
            "#json-dlg ul{list-style:none;margin:0 0 .4rem;padding:0}" +
            "#json-dlg li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem .1rem;border-bottom:1px solid #21262d;font-size:.88rem}" +
            "#json-dlg li:last-child{border-bottom:none}" +
            "#json-dlg li .v{font-weight:700}" +
            "#json-dlg li.pos .v{color:#7ee787}#json-dlg li.upd .v{color:#79c0ff}#json-dlg li.warn .v{color:#f0b849}" +
            "#json-dlg .note{margin-top:.9rem;font-size:.76rem;color:#8b949e;line-height:1.5;background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:.6rem .7rem}" +
            "#json-dlg .err{font-size:.9rem;color:#ffb3b3;line-height:1.55;margin:.2rem 0 .4rem}" +
            "#json-dlg .tpl-actions{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1.1rem}" +
            "#json-dlg button{padding:.55rem 1.1rem;border-radius:8px;font-weight:600;font-size:.85rem;cursor:pointer;border:1px solid transparent}" +
            "#json-dlg .json-cancel{background:#21262d;color:#e6edf3;border-color:#2b3340}" +
            "#json-dlg .json-confirm,#json-dlg #jsonResultOk{background:#10b981;color:#fff}" +
            "#json-dlg .json-confirm:hover,#json-dlg #jsonResultOk:hover{background:#0ea371}" +
            "#json-dlg button:disabled{opacity:.6;cursor:not-allowed}";
        document.head.appendChild(st);
    }

    function confirmJsonUpload(info, onConfirm) {
        ensureJsonDialogStyle();
        const existing = document.getElementById('json-dlg-overlay');
        if (existing) existing.parentNode.removeChild(existing);
        const a = info.asset || {};
        const outOfScope = Math.max(0, (info.total || 0) - (info.inScope || 0));
        const scopeRows = info.scoped
            ? `<li class="pos"><span>Rows within this dashboard's scope</span><span class="v">${(info.inScope || 0).toLocaleString()}</span></li>` +
              (outOfScope ? `<li class="warn"><span>Outside scope (won't display here)</span><span class="v">${outOfScope.toLocaleString()}</span></li>` : '')
            : '';
        const body =
            '<h3>🗄️ Replace ' + jsonEsc(a.label || 'data') + '?</h3>' +
            '<p class="sub">' + jsonEsc(info.fileName || '') + '</p>' +
            '<ul>' +
            '<li><span>Records in file</span><span class="v">' + (info.total || 0).toLocaleString() + '</span></li>' +
            scopeRows +
            '</ul>' +
            '<div class="note">This replaces <strong>' + jsonEsc(a.label || 'the data') + '</strong> for <strong>every user</strong> of this dashboard and persists across refreshes. This dashboard’s feeder configuration is applied automatically on load. This cannot be undone — re-upload the previous file to revert.</div>';
        const ov = document.createElement('div');
        ov.id = 'json-dlg-overlay';
        ov.innerHTML =
            '<div id="json-dlg" role="dialog" aria-modal="true" aria-label="Confirm data upload">' +
            body +
            '<div class="tpl-actions" style="justify-content:space-between">' +
            '<button type="button" class="json-cancel" id="jsonCancel">Cancel</button>' +
            '<button type="button" class="json-confirm" id="jsonConfirm">Publish to everyone</button>' +
            '</div></div>';
        document.body.appendChild(ov);
        const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
        document.getElementById('jsonCancel').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        document.getElementById('jsonConfirm').addEventListener('click', () => {
            const b = document.getElementById('jsonConfirm');
            b.disabled = true; b.textContent = 'Publishing…';
            close();
            onConfirm();
        });
    }

    function showJsonResult(r) {
        ensureJsonDialogStyle();
        const existing = document.getElementById('json-dlg-overlay');
        if (existing) existing.parentNode.removeChild(existing);
        let body;
        if (r.error) {
            body = '<h3>⚠️ Couldn’t update data</h3>' +
                (r.fileName ? '<p class="sub">' + jsonEsc(r.fileName) + '</p>' : '') +
                '<div class="err">' + jsonEsc(r.error) + '</div>';
        } else {
            const a = r.asset || {};
            body =
                '<h3>✅ Dashboard data updated</h3>' +
                '<p class="sub">' + jsonEsc(r.fileName || '') + '</p>' +
                '<ul>' +
                '<li class="pos"><span>Records published</span><span class="v">' + Number(r.total || 0).toLocaleString() + '</span></li>' +
                (r.scoped ? '<li class="upd"><span>Showing on this dashboard</span><span class="v">' + Number(r.inScope || 0).toLocaleString() + '</span></li>' : '') +
                '</ul>' +
                '<div class="note"><strong>Published to everyone.</strong> The dashboard has been refreshed with the new ' + jsonEsc(a.label || 'data') + '. All other users will see it on their next load.</div>';
        }
        const ov = document.createElement('div');
        ov.id = 'json-dlg-overlay';
        ov.innerHTML =
            '<div id="json-dlg" role="dialog" aria-modal="true" aria-label="Data upload result">' +
            body +
            '<div class="tpl-actions"><button type="button" id="jsonResultOk">Done</button></div></div>';
        document.body.appendChild(ov);
        const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
        document.getElementById('jsonResultOk').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    }


    // =====================================================================
    // AI DATA ASSISTANT  —  offline analytics engine (no LLM, no API keys).
    // Answers free-form questions about the *real* dataset: poles, pole type,
    // buildings connected, building-SLRN linkage, geography (BU / undertaking /
    // feeder / DT / area), field officers, vendors, velocity & trends, BOQ
    // targets & completion, and individual SLRN look-ups. Understands loose
    // phrasing via synonyms, number-words and fuzzy entity matching.
    //
    // Honesty note: this dataset carries no real pole-condition grading (every
    // record is Status=COMPLETE); `simulateIssue` fills Issue_Type with random
    // values. So the assistant does NOT report defect/quality figures as fact —
    // it says condition data isn't captured and pivots to what is known.
    // =====================================================================
    (function initAIAssistant() {
        const askBtn = document.getElementById('ai-ask-btn');
        const inputEl = document.getElementById('ai-query');
        const responseEl = document.getElementById('ai-response');
        const chipsEl = document.getElementById('ai-suggestions');
        if (!askBtn || !inputEl || !responseEl) return;

        const ask = () => runQuery(inputEl.value);
        askBtn.addEventListener('click', ask);
        inputEl.addEventListener('keypress', (e) => { if (e.key === 'Enter') ask(); });

        // Clickable example chips — one tap fills the box and runs the query.
        const CHIPS = ['Scorecard', 'Summary', 'Top 5 field officers', 'Run rate by vendor',
            'Concrete vs wooden', 'New poles installed', 'Activity last 7 days',
            'Feeders behind on BOQ', 'Building-SLRN linkage'];
        if (chipsEl) {
            chipsEl.innerHTML = CHIPS.map(c => '<button type="button" class="ai-chip">' + esc(c) + '</button>').join('');
            chipsEl.querySelectorAll('.ai-chip').forEach(btnEl => btnEl.addEventListener('click', () => {
                inputEl.value = btnEl.textContent;
                runQuery(btnEl.textContent);
            }));
        }

        // ---------- safe rendering helpers ----------
        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        const bold = (s) => '<strong>' + esc(s) + '</strong>';
        const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString() : esc(n);
        const pctOf = (num, den) => den > 0 ? (num / den * 100) : 0;
        const pct1 = (num, den) => pctOf(num, den).toFixed(1) + '%';
        const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
        const titleCase = (s) => String(s).replace(/\b\w/g, c => c.toUpperCase());

        // Reveal with a brief "thinking" beat, then the answer (fades in via CSS).
        let thinkTimer = null;
        function show(html) {
            if (thinkTimer) clearTimeout(thinkTimer);
            responseEl.classList.remove('visible');
            responseEl.innerHTML = '<div class="ai-loading"><span></span><span></span><span></span></div>';
            responseEl.classList.add('visible');
            thinkTimer = setTimeout(() => { responseEl.innerHTML = html; }, 380);
        }

        // ---------- visual render helpers (self-contained, theme-aware) ----------
        // NOTE: callers pass pre-escaped label HTML (via esc()/bold()); numbers go
        // through fmt(). These builders never receive raw user/data strings unescaped.
        function barChart(rows, unit) {
            const max = Math.max(1, ...rows.map(r => r.value));
            return '<div class="ai-chart">' + rows.map((r, i) =>
                '<div class="row"><span class="lbl"><span class="rank">' + (i + 1) + '.</span> ' + r.label + '</span>' +
                '<span class="track"><span style="width:' + Math.max(2, Math.round(r.value / max * 100)) + '%"></span></span>' +
                '<span class="num">' + fmt(r.value) + (unit ? ' ' + esc(unit) : '') + '</span></div>'
            ).join('') + '</div>';
        }
        function meter(pct, capLeft, capRight) {
            // Cap the shown % (and the bar) at 100 to match the dashboard's completion
            // card; the "of X target" caption still conveys any over-achievement.
            const p = Math.max(0, Math.min(100, isFinite(pct) ? pct : 0));
            return '<div class="ai-meter"><div class="cap"><span>' + (capLeft || '') + '</span>' +
                '<span class="pct">' + p.toFixed(1) + '%</span></div>' +
                '<div class="ai-bar"><span style="width:' + p + '%"></span></div>' +
                (capRight ? '<div class="cap" style="margin-top:.25rem"><span>' + capRight + '</span><span></span></div>' : '') + '</div>';
        }
        function tiles(items) {
            return '<div class="ai-tiles">' + items.map(t =>
                '<div class="ai-tile"><div class="t-val">' + t.val + '</div><div class="t-lbl">' + esc(t.label) + '</div></div>'
            ).join('') + '</div>';
        }
        function kpiCards(cards) {
            return '<div class="ai-kpis">' + cards.map(c => {
                const of = (c.of != null) ? ' <span class="of">/ ' + fmt(c.of) + '</span>' : '';
                const bar = (c.of != null && c.of > 0)
                    ? '<div class="ai-bar" style="margin-top:.4rem"><span style="width:' + Math.min(100, c.val / c.of * 100) + '%"></span></div>' : '';
                return '<div class="ai-kpi"><span class="k-title">' + esc(c.title) +
                    (c.tag ? ' <span class="k-tag">' + esc(c.tag) + '</span>' : '') + '</span>' +
                    '<div class="k-val">' + fmt(c.val) + of + '</div>' + bar +
                    (c.sub ? '<div class="k-sub">' + c.sub + '</div>' : '') + '</div>';
            }).join('') + '</div>';
        }
        const PROP_COLORS = ['hsl(var(--primary))', 'hsl(var(--accent))', 'hsl(38 92% 55%)', 'hsl(280 60% 62%)', 'hsl(var(--muted-foreground))'];
        function propBar(segments) {
            const total = segments.reduce((s, x) => s + x.value, 0) || 1;
            const bar = segments.map((s, i) => '<span style="width:' + (s.value / total * 100) + '%;background:' +
                (s.color || PROP_COLORS[i % PROP_COLORS.length]) + '"></span>').join('');
            const legend = segments.map((s, i) => '<span><span class="dot" style="background:' +
                (s.color || PROP_COLORS[i % PROP_COLORS.length]) + '"></span>' + esc(s.label) +
                ' <b>' + pct1(s.value, total) + '</b> (' + fmt(s.value) + ')</span>').join('');
            return '<div class="ai-prop">' + bar + '</div><div class="ai-legend">' + legend + '</div>';
        }

        // ---------- metric helpers (real fields only) ----------
        const dayOf = (d) => (d['Date/timestamp'] || '').split(' ')[0];
        const activeDates = (ds) => [...new Set(ds.map(dayOf).filter(Boolean))];
        function runRate(ds) {
            const days = activeDates(ds).length || 1;
            return { total: ds.length, days, rate: +(ds.length / days).toFixed(1) };
        }
        function poleTypes(ds) {
            const c = {};
            ds.forEach(d => { const t = (d['Type of Pole'] || 'Unknown').toUpperCase(); c[t] = (c[t] || 0) + 1; });
            return c;
        }
        function buildingsStats(ds) {
            let total = 0, withB = 0, max = 0;
            ds.forEach(d => {
                const n = parseInt(d['No of Buildings Connected to the Pole']) || 0;
                total += n; if (n > 0) withB++; if (n > max) max = n;
            });
            return { total, withB, max, avg: ds.length ? +(total / ds.length).toFixed(2) : 0, n: ds.length };
        }
        function linkage(ds) {
            const linked = ds.filter(d => String(d['Associated Buildings SLRN'] || '').trim()).length;
            return { linked, unlinked: ds.length - linked, n: ds.length };
        }
        const uniqCount = (ds, field) => new Set(ds.map(d => d[field]).filter(Boolean)).size;
        // A "pole" is a unique SLRN (a pole tagged twice is one pole) — this is how the
        // dashboard KPI cards count, so headline pole tallies here use it for parity.
        const slrnOf = d => String(d['Lt PoleSLRN'] || d['LT Pole No'] || '').trim();
        const poleCount = (ds) => { const s = new Set(); ds.forEach(d => { const x = slrnOf(d); if (x) s.add(x); }); return s.size; };
        function groupCount(ds, keyFn) {
            const c = {};
            ds.forEach(d => { const k = keyFn(d); if (k != null && k !== '') c[k] = (c[k] || 0) + 1; });
            return c;
        }
        // Ordered [ [key, count], ... ] descending (or ascending when asc=true).
        const rankEntries = (obj, asc) => Object.entries(obj).sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]);

        // BOQ target per feeder (normalised feeder key -> target poles).
        const boqTotal = () => (boqData || []).reduce((s, d) => s + (parseInt(d['POLES Grand Total']) || 0), 0);
        // BOQ rows in scope for a (possibly filtered) dataset `ds`. `ds` already
        // reflects BOTH the dashboard's feeder/DT multiselects (via filteredData) AND
        // any AI entity filter, so scope is derived from it directly. Like the
        // dashboard's updateKPIs, we scope by FEEDER NAME — so a feeder's not-yet-
        // tagged DTs still count toward the target — and tighten to DT NAME only when
        // a single DT is in scope. Unfiltered → the whole (already allowlisted) BOQ.
        function boqScopeRows(ds) {
            if (!ds || ds.length >= globalData.length) return boqData || [];
            const feeders = new Set(ds.map(d => norm(d.Feeder)).filter(Boolean));
            let rows = (boqData || []).filter(d => feeders.has(norm(d['FEEDER NAME'])));
            const dts = new Set(ds.map(d => norm(d['DT Name'])).filter(Boolean));
            if (dts.size === 1) rows = rows.filter(d => dts.has(norm(d['DT NAME'])));
            return rows;
        }
        const boqTargetForScope = (ctx) => boqScopeRows(ctx.data).reduce((s, d) => s + (parseInt(d['POLES Grand Total']) || 0), 0);

        // ---------- fuzzy matching (Levenshtein) ----------
        function lev(a, b) {
            if (a === b) return 0;
            if (!a.length) return b.length;
            if (!b.length) return a.length;
            const m = [];
            for (let i = 0; i <= b.length; i++) m[i] = [i];
            for (let j = 0; j <= a.length; j++) m[0][j] = j;
            for (let i = 1; i <= b.length; i++)
                for (let j = 1; j <= a.length; j++)
                    m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1]
                        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
            return m[b.length][a.length];
        }
        // Best fuzzy match of any query token against a list of names.
        function fuzzyBest(qTokens, list) {
            let best = null, bestScore = 0;
            list.forEach(item => {
                const itemTokens = norm(item).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
                itemTokens.forEach(it => {
                    qTokens.forEach(qt => {
                        if (qt.length < 3) return;
                        const d = lev(qt, it);
                        const score = 1 - d / Math.max(qt.length, it.length);
                        if (score > bestScore && score >= 0.72) { bestScore = score; best = item; }
                    });
                });
            });
            return best ? { value: best, score: bestScore } : null;
        }

        // ---------- query normalisation ----------
        const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50 };
        const SYNONYMS = [
            [/\b(velocity|pace|throughput|productivity|speed)\b/g, 'run rate'],
            [/\b(officers?|agents?|surveyors?|enumerators?|staff|personnel|workers?|field ?officers?)\b/g, 'user'],
            [/\b(transformers?)\b/g, 'dt'],
            [/\bwood\b/g, 'wooden'],
            [/\b(premises|households?|houses|homes|structures?)\b/g, 'buildings'],
            [/\b(bu|business ?units?)\b/g, 'businessunit'],
            [/\b(u ?ts?|undertakings?)\b/g, 'undertaking'],
            [/\b(defects?|faults?|damaged?|broken|vandali[sz]ed?|crooked|condition|quality)\b/g, 'issue'],
            [/\b(leaderboard|ranking|rank)\b/g, 'top'],
        ];
        // Words that signal a BOQ shortfall question. Kept as a separate list (not
        // folded into a "behind" synonym) so these common words don't hijack
        // officer/vendor/undertaking questions into the feeder-BOQ ranking.
        const BEHIND_RE = /\b(behind|lagging|shortfall|outstanding|remaining|gap)\b/;
        const BOQ_CTX_RE = /\b(boq|target|bill of quant|completion|complete|feeder)\b/;
        function normalize(raw) {
            let q = ' ' + String(raw || '').toLowerCase().replace(/[^\w\s\-/]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
            SYNONYMS.forEach(([re, to]) => { q = q.replace(re, to); });
            Object.keys(NUM_WORDS).forEach(w => { q = q.replace(new RegExp('\\b' + w + '\\b', 'g'), NUM_WORDS[w]); });
            return q.replace(/\s+/g, ' ').trim();
        }
        const has = (q, re) => re.test(q);
        // A row count only counts when it directly follows a ranking/quantity word,
        // so digits embedded in feeder/DT codes (e.g. "11-Alapere") don't hijack it.
        function limitFrom(q, fallback) {
            const m = q.match(/\b(?:top|bottom|first|last|show|list)\s+(\d{1,3})\b/);
            return m ? Math.max(1, Math.min(50, parseInt(m[1]))) : fallback;
        }

        // ---------- dimension registry ----------
        function dims(data) {
            return {
                vendor: { field: 'Vendor_Name', label: 'Vendor', disp: v => v },
                feeder: { field: 'Feeder', label: 'Feeder', disp: v => v },
                dt: { field: 'DT Name', label: 'DT', disp: v => v },
                undertaking: { field: 'Undertaking', label: 'Undertaking', disp: v => v },
                businessunit: { field: 'Bussines Unit', label: 'Business Unit', disp: v => v },
                user: { field: 'User', label: 'Field Officer', disp: v => getDisplayName(v) },
            };
        }

        // Whole-token match: `value` must appear on word boundaries, so a short
        // entity name (e.g. undertaking "igbobi") can't match inside a longer token
        // (feeder "…igbobiinj…") and stack a bogus filter.
        const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordIn = (q, s) => new RegExp('\\b' + escRe(s) + '\\b').test(q);

        // ---------- entity / context detection ----------
        // Returns { filters:[{dim,value}], data:filteredSubset, label, vendorsHit:[...] }
        function detectContext(q, qTokens, data) {
            const spec = dims(data);
            const filters = [];
            const vendorsAll = [...new Set(data.map(d => d.Vendor_Name).filter(Boolean))];

            // Vendors (with short aliases).
            const vendorsHit = [];
            vendorsAll.forEach(v => { if (wordIn(q, norm(v))) vendorsHit.push(v); });
            [['etc', 'ETC'], ['jesom', 'Jesom'], ['ikeja', 'Ikeja'], ['ie', 'Ikeja']].forEach(([a, key]) => {
                if (new RegExp('\\b' + a + '\\b').test(q)) {
                    const v = vendorsAll.find(x => x.includes(key));
                    if (v && !vendorsHit.includes(v)) vendorsHit.push(v);
                }
            });
            if (vendorsHit.length === 1) filters.push({ dim: 'vendor', value: vendorsHit[0] });

            // Feeder / DT / Undertaking / Business Unit — full-value substring, or a
            // distinctive token match when the dimension word is present.
            [['feeder', /\bfeeder/], ['dt', /\bdt\b/], ['undertaking', /\bundertaking\b/], ['businessunit', /\bbusinessunit\b/]]
                .forEach(([dim, dimRe]) => {
                    const vals = [...new Set(data.map(d => d[spec[dim].field]).filter(Boolean))].sort((a, b) => b.length - a.length);
                    let hit = vals.find(v => norm(v).length >= 4 && wordIn(q, norm(v)));
                    if (!hit && dimRe.test(q)) {
                        // distinctive token (>=5 chars, not pure digits) uniquely identifying one value
                        let bestTokLen = 4, best = null;
                        vals.forEach(v => {
                            norm(v).split(/[^a-z0-9]+/).forEach(tok => {
                                if (tok.length > bestTokLen && !/^\d+$/.test(tok) && qTokens.includes(tok)) { bestTokLen = tok.length; best = v; }
                            });
                        });
                        hit = best;
                    }
                    if (hit) filters.push({ dim, value: hit });
                });

            // Users — username or full-name substring.
            const usersAll = [...new Set(data.map(d => d.User).filter(Boolean))];
            const userHit = usersAll.find(u => {
                const un = norm(u), fn = norm(getDisplayName(u));
                return (un.length >= 4 && wordIn(q, un)) || (fn.length >= 5 && wordIn(q, fn));
            });
            if (userHit) filters.push({ dim: 'user', value: userHit });

            let sub = data, label = [];
            filters.forEach(f => { sub = sub.filter(d => d[spec[f.dim].field] === f.value); label.push(spec[f.dim].disp(f.value)); });
            return { filters, data: sub, label: label.join(' › ') || 'all data', vendorsHit, spec, vendorsAll };
        }

        // ---------- answer builders ----------
        function contextNote(ctx) {
            return ctx.filters.length ? '<br><br><small>Scope: ' + esc(ctx.label) + '</small>' : '';
        }

        function summaryAnswer(ctx) {
            const ds = ctx.data;
            const rr = runRate(ds), bs = buildingsStats(ds), lk = linkage(ds), pt = poleTypes(ds);
            const typeStr = rankEntries(pt).map(([k, v]) => esc(titleCase(k)) + ' ' + pct1(v, ds.length)).join(' · ');
            // BOQ targets are geographic, so "completion" divides by the target for
            // THIS scope, and is suppressed for vendor/officer scopes.
            const geoScope = !ctx.filters.some(f => f.dim === 'vendor' || f.dim === 'user');
            const bt = geoScope ? boqTargetForScope(ctx) : 0;
            const nPoles = poleCount(ds); // unique SLRN, matching the dashboard KPI
            let out = '<div class="ai-head">📊 ' + esc(titleCase(ctx.label)) + ' — snapshot</div>';
            if (bt > 0) out += meter(pctOf(nPoles, bt), 'BOQ completion', 'Poles tagged ' + bold(fmt(nPoles)) + ' of ' + bold(fmt(bt)) + ' target');
            out += tiles([
                { val: bold(fmt(nPoles)), label: 'Poles tagged' },
                { val: bold(uniqCount(ds, 'User')), label: 'Field officers' },
                { val: bold(rr.rate), label: 'Poles / day' },
                { val: bold(uniqCount(ds, 'Feeder')), label: 'Feeders' },
                { val: bold(uniqCount(ds, 'DT Name')), label: 'DTs' },
                { val: bold(fmt(bs.total)), label: 'Buildings' },
            ]);
            out += '<div class="ai-row">Pole types: ' + typeStr + ' · Building-SLRN linkage: ' + bold(pct1(lk.linked, lk.n)) + '</div>';
            out += '<small>💡 Try "scorecard", "top 5 feeders", or "feeders behind on BOQ".</small>';
            return out + contextNote(ctx);
        }

        // ---------- dashboard KPI scorecard (mirrors updateKPIs) ----------
        function kpiStats(ctx) {
            const ds = ctx.data;
            const slrnOf = d => String(d['Lt PoleSLRN'] || d['LT Pole No'] || '').trim();
            const poleSet = new Set(), newSet = new Set(), bldgSet = new Set();
            const isNew = (typeof isNewInstallPole === 'function') ? isNewInstallPole : () => false;
            ds.forEach(d => {
                const s = slrnOf(d); if (s) poleSet.add(s);
                if (s && isNew(d)) newSet.add(s);
                String(d['Associated Buildings SLRN'] || '').split(';').forEach(b => { const t = b.trim(); if (t) bldgSet.add(t); });
            });
            const captured = ds.filter(d => d.__gisCaptured !== false);
            // BOQ subset scoped to whatever narrowed ds (dashboard filter AND/OR AI
            // entity filter), mirroring the dashboard's activeBoqData.
            const boqScope = boqScopeRows(ds);
            const sum = k => boqScope.reduce((s, d) => s + (parseInt(d[k]) || 0), 0);
            const boqTot = sum('POLES Grand Total'), boqNew = sum('NEW POLE');
            const actPoles = poleSet.size, actNew = newSet.size;
            return {
                actPoles, actNew, actExNew: Math.max(0, actPoles - actNew),
                actUsers: new Set(captured.map(d => d.User).filter(Boolean)).size,
                actFeeders: new Set(captured.map(d => d.Feeder).filter(Boolean)).size,
                actDTs: new Set(captured.map(d => d['DT Name']).filter(Boolean)).size,
                actBuildings: bldgSet.size,
                boqTot, boqNew, boqExNew: Math.max(0, boqTot - boqNew),
                boqFeeders: new Set(boqScope.map(d => d['FEEDER NAME']).filter(Boolean)).size,
                boqDTs: new Set(boqScope.map(d => d['DT NAME']).filter(Boolean)).size,
            };
        }

        function kpiAnswer(ctx) {
            const k = kpiStats(ctx);
            const geo = !ctx.filters.some(f => f.dim === 'vendor' || f.dim === 'user');
            const t = (title, val, of, remaining) => ({
                title, val, of: (geo && of) ? of : null,
                sub: (geo && of) ? 'Remaining ' + bold(fmt(Math.max(0, of - val))) : ''
            });
            let out = '<div class="ai-head">📊 Dashboard scorecard — ' + esc(titleCase(ctx.label)) + '</div>';
            if (geo && k.boqTot > 0) {
                out += meter(pctOf(k.actPoles, k.boqTot), 'Overall completion',
                    'Poles tagged ' + bold(fmt(k.actPoles)) + ' of ' + bold(fmt(k.boqTot)) + ' BOQ target');
            }
            out += kpiCards([
                t('Total Poles (incl. new)', k.actPoles, k.boqTot),
                t('Poles excl. new', k.actExNew, k.boqExNew),
                t('New Poles (install)', k.actNew, k.boqNew),
                t('Feeders', k.actFeeders, k.boqFeeders),
                t('DTs', k.actDTs, k.boqDTs),
                { title: 'Buildings', val: k.actBuildings },
                { title: 'Active officers', val: k.actUsers },
            ]);
            out += '<small>Actuals are unique by pole SLRN, matching the dashboard KPI cards. Condition (good/bad) split isn\'t field-measured, so it\'s left out.</small>';
            return out + contextNote(ctx);
        }

        // Rank a dimension by a chosen metric.
        function rankAnswer(q, ctx, asc) {
            const ds = ctx.data, spec = ctx.spec;
            const limit = limitFrom(q, 5);
            const dir = asc ? 'Bottom' : 'Top';

            // pick dimension
            let dimKey = 'user';
            if (has(q, /\bvendor/)) dimKey = 'vendor';
            else if (has(q, /\bfeeder/)) dimKey = 'feeder';
            else if (has(q, /\bdt\b/)) dimKey = 'dt';
            else if (has(q, /\bundertaking\b/)) dimKey = 'undertaking';
            else if (has(q, /\bbusinessunit\b/)) dimKey = 'businessunit';
            else if (has(q, /\barea|\blocation|\baddress|\bstreet|\bwhere\b/)) dimKey = 'area';

            // pick metric
            const byRate = has(q, /\brun rate\b/);
            const byBuildings = has(q, /\bbuildings\b/);

            const keyFn = dimKey === 'area'
                ? (d => { const a = d['Location address']; return a ? (a.split(',').pop().trim() || a) : ''; })
                : (d => d[spec[dimKey] ? spec[dimKey].field : 'User']);
            const dispFn = dimKey === 'user' ? (k => esc(getDisplayName(k)))
                : (k => esc(k));
            const dimLabel = dimKey === 'area' ? 'Areas' : (spec[dimKey].label + 's');

            if (byRate && dimKey !== 'area') {
                // metric = poles / active days for that group
                const groups = {};
                ds.forEach(d => { const k = keyFn(d); if (k) (groups[k] = groups[k] || []).push(d); });
                const rows = Object.entries(groups).map(([k, g]) => ({ label: dispFn(k), value: runRate(g).rate }))
                    .sort((a, b) => asc ? a.value - b.value : b.value - a.value).slice(0, limit);
                return '<div class="ai-head">🏁 ' + dir + ' ' + rows.length + ' ' + esc(dimLabel) + ' by run rate</div>' +
                    barChart(rows, '/day') + contextNote(ctx);
            }
            if (byBuildings) {
                const groups = {};
                ds.forEach(d => { const k = keyFn(d); if (k) groups[k] = (groups[k] || 0) + (parseInt(d['No of Buildings Connected to the Pole']) || 0); });
                const rows = rankEntries(groups, asc).slice(0, limit).map(r => ({ label: dispFn(r[0]), value: r[1] }));
                return '<div class="ai-head">🏢 ' + dir + ' ' + rows.length + ' ' + esc(dimLabel) + ' by buildings connected</div>' +
                    barChart(rows, 'buildings') + contextNote(ctx);
            }
            // default metric = pole count
            const rows = rankEntries(groupCount(ds, keyFn), asc).slice(0, limit).map(r => ({ label: dispFn(r[0]), value: r[1] }));
            const noun = dimKey === 'user' ? '👷' : dimKey === 'feeder' ? '🔌' : dimKey === 'vendor' ? '🏗️' : '📍';
            return '<div class="ai-head">' + noun + ' ' + dir + ' ' + rows.length + ' ' + esc(dimLabel) + ' by poles tagged</div>' +
                barChart(rows, 'poles') + contextNote(ctx);
        }

        function compareAnswer(q, ctx) {
            const data = ctx.data, spec = ctx.spec;
            const build = (field, vals, dispFn) => vals.map(v => {
                const vd = data.filter(d => d[field] === v);
                return vd.length ? { name: dispFn(v), poles: vd.length, rate: runRate(vd).rate, bldg: buildingsStats(vd).total } : null;
            }).filter(Boolean);
            // Which dimension does the user want to compare? Explicit word wins; else vendors.
            let dimKey = 'vendor';
            if (has(q, /\bfeeder/)) dimKey = 'feeder';
            else if (has(q, /\bdt\b/)) dimKey = 'dt';
            else if (has(q, /\bundertaking\b/)) dimKey = 'undertaking';
            else if (has(q, /\buser\b/)) dimKey = 'user';
            else if (has(q, /\bbusinessunit\b/)) dimKey = 'businessunit';

            let items, head;
            if (dimKey === 'vendor') {
                let targets = ctx.vendorsHit.slice();
                if (targets.length < 2) targets = ctx.vendorsAll;
                items = build('Vendor_Name', targets, v => v);
                if (!items.length) return 'I could not find those vendors to compare. Try "compare ETC vs Jesom".';
                head = '⚖️ Vendor comparison';
            } else {
                const field = spec[dimKey].field;
                const dispFn = dimKey === 'user' ? getDisplayName : (v => v);
                const top = rankEntries(groupCount(data, d => d[field])).slice(0, 6).map(e => e[0]);
                items = build(field, top, dispFn);
                if (items.length < 2) return null; // nothing meaningful to compare → let router fall through
                head = '⚖️ ' + spec[dimKey].label + ' comparison (top ' + items.length + ')';
            }
            const bars = barChart(items.map(x => ({ label: esc(x.name), value: x.poles })), 'poles');
            const detail = items.map(x => '<div class="ai-row">' + bold(x.name) + ' — ' + x.rate + '/day · ' + fmt(x.bldg) + ' buildings</div>').join('');
            return '<div class="ai-head">' + esc(head) + '</div>' + bars + detail + contextNote(ctx);
        }

        function runRateAnswer(ctx) {
            const ds = ctx.data, rr = runRate(ds);
            let out = '<div class="ai-head">🏁 ' + esc(titleCase(ctx.label)) + ' — run rate</div>' +
                'Overall: ' + bold(rr.rate + ' poles/day') + ' (' + fmt(rr.total) + ' poles over ' + rr.days + ' active days)';
            if (!ctx.filters.some(f => f.dim === 'vendor')) {
                const per = ctx.vendorsAll.map(v => {
                    const vd = ds.filter(d => d.Vendor_Name === v);
                    return vd.length ? bold(v) + ': ' + runRate(vd).rate + '/day' : null;
                }).filter(Boolean);
                if (per.length > 1) out += '<br><br>By vendor:<br>' + per.join('<br>');
            }
            return out + '<br><br><small>Target: &gt;50 poles/day/officer.</small>' + contextNote(ctx);
        }

        function trendAnswer(q, ctx) {
            const ds = ctx.data;
            const byDay = {};
            ds.forEach(d => { const day = dayOf(d); if (day) byDay[day] = (byDay[day] || 0) + 1; });
            // Parse to real calendar dates so windows are calendar days, not "active" days.
            const sorted = Object.keys(byDay).map(day => ({ day, t: new Date(day).getTime(), n: byDay[day] }))
                .filter(x => isFinite(x.t)).sort((a, b) => a.t - b.t);
            if (!sorted.length) return 'No date-stamped records are in the current scope.';
            const anchor = sorted[sorted.length - 1].t;
            const DAY = 86400000;
            // Active days falling in the calendar window (end inclusive, spanning n days).
            const windowDays = (end, n) => sorted.filter(x => x.t <= end && x.t > end - n * DAY);

            let winDays, label, end = anchor;
            const dm = q.match(/last (\d+) day/);
            if (dm) { winDays = Math.max(1, parseInt(dm[1])); label = 'last ' + winDays + ' day' + (winDays === 1 ? '' : 's'); }
            else if (q.includes('yesterday')) { winDays = 1; label = 'yesterday'; end = anchor - DAY; }
            else if (q.includes('today')) { winDays = 1; label = 'latest day'; }
            else if (q.includes('week')) { winDays = 7; label = 'last 7 days'; }
            else { winDays = 10; label = 'last 10 days'; }

            const win = windowDays(end, winDays);
            const list = win.length ? win.map(x => esc(x.day) + ': ' + bold(x.n)).join('<br>') : '<em>no activity in this window</em>';
            const totalR = win.reduce((s, x) => s + x.n, 0);
            const avgR = (totalR / winDays).toFixed(1);
            // Momentum: last 7 calendar days vs the 7 before them.
            let momentum = '';
            const cur = windowDays(anchor, 7), prev = windowDays(anchor - 7 * DAY, 7);
            if (prev.length) {
                const la = cur.reduce((s, x) => s + x.n, 0) / 7;
                const pa = prev.reduce((s, x) => s + x.n, 0) / 7;
                const delta = pa > 0 ? Math.round((la - pa) / pa * 100) : 0;
                const word = delta > 5 ? 'accelerating ▲' : delta < -5 ? 'slowing ▼' : 'holding steady';
                momentum = '<br><br>Momentum: ' + bold(word) + ' (' + (delta >= 0 ? '+' : '') + delta + '% vs prior week)';
            }
            return '<div class="ai-head">📈 Activity — ' + esc(titleCase(ctx.label)) + ' (' + esc(label) + ')</div>' +
                list + '<br><br>Period total: ' + bold(fmt(totalR)) + ' · avg ' + bold(avgR + '/day') + momentum + contextNote(ctx);
        }

        function poleTypeAnswer(ctx) {
            const ds = ctx.data, pt = poleTypes(ds);
            const segs = rankEntries(pt).map(([k, v]) => ({ label: titleCase(k), value: v }));
            return '<div class="ai-head">🪵 Pole types — ' + esc(titleCase(ctx.label)) + '</div>' +
                propBar(segs) + contextNote(ctx);
        }

        function buildingsAnswer(ctx) {
            const bs = buildingsStats(ctx.data);
            return '<div class="ai-head">🏢 Buildings connected — ' + esc(titleCase(ctx.label)) + '</div>' +
                tiles([
                    { val: bold(fmt(bs.total)), label: 'Total served' },
                    { val: bold(bs.avg), label: 'Avg / pole' },
                    { val: bold(fmt(bs.max)), label: 'Busiest pole' },
                    { val: bold(pct1(bs.withB, bs.n)), label: 'Poles w/ bldg' },
                ]) +
                meter(pctOf(bs.withB, bs.n), 'Poles carrying at least one building',
                    bold(fmt(bs.withB)) + ' of ' + bold(fmt(bs.n)) + ' poles') + contextNote(ctx);
        }

        function linkageAnswer(ctx) {
            const lk = linkage(ctx.data);
            return '<div class="ai-head">🔗 Building-SLRN linkage — ' + esc(titleCase(ctx.label)) + '</div>' +
                propBar([
                    { label: 'Linked', value: lk.linked, color: 'hsl(var(--accent))' },
                    { label: 'Not linked', value: lk.unlinked, color: 'hsl(var(--muted-foreground))' },
                ]) +
                '<small>💡 Unlinked poles are candidates for building-tagging follow-up.</small>' + contextNote(ctx);
        }

        function boqAnswer(q, ctx) {
            if (!boqData || !boqData.length) return 'No BOQ (Bill of Quantities) targets are loaded.';
            const actual = poleCount(ctx.data); // unique SLRN, matching the dashboard KPI
            // Feeders behind / completion per feeder.
            if (has(q, /\bfeeder\b/) || BEHIND_RE.test(q)) {
                // Targets scoped to the feeders actually in scope (so a dashboard/AI
                // filter doesn't pin every out-of-scope feeder at 0% and dominate).
                const targetByF = {}, dispByF = {};
                boqScopeRows(ctx.data).forEach(d => {
                    const f = norm(d['FEEDER NAME']); if (!f) return;
                    targetByF[f] = (targetByF[f] || 0) + (parseInt(d['POLES Grand Total']) || 0);
                    if (!dispByF[f]) dispByF[f] = d['FEEDER NAME'];
                });
                const actualByF = {};
                ctx.data.forEach(d => { const f = norm(d.Feeder); if (!f) return; const s = slrnOf(d); if (!s) return; (actualByF[f] = actualByF[f] || new Set()).add(s); if (!dispByF[f]) dispByF[f] = d.Feeder; });
                const rows = Object.keys(targetByF)
                    .map(f => ({ f, t: targetByF[f], a: actualByF[f] ? actualByF[f].size : 0, disp: dispByF[f] || f }))
                    .filter(r => r.t > 0);
                const behind = BEHIND_RE.test(q) || has(q, /\bbottom|worst|lowest\b/);
                rows.sort((a, b) => behind ? (a.a / a.t) - (b.a / b.t) : (b.a / b.t) - (a.a / a.t));
                const limit = limitFrom(q, 8);
                // Each feeder as a 0–100% completion bar with "tagged/target".
                const chart = '<div class="ai-chart">' + rows.slice(0, limit).map((r, i) => {
                    const p = pctOf(r.a, r.t);
                    return '<div class="row"><span class="lbl"><span class="rank">' + (i + 1) + '.</span> ' + esc(titleCase(r.disp)) + '</span>' +
                        '<span class="track"><span style="width:' + Math.min(100, p) + '%"></span></span>' +
                        '<span class="num">' + p.toFixed(0) + '% <small>(' + fmt(r.a) + '/' + fmt(r.t) + ')</small></span></div>';
                }).join('') + '</div>';
                const head = behind ? '🚧 Feeders furthest behind BOQ' : '✅ Feeders closest to BOQ target';
                return '<div class="ai-head">' + head + '</div>' + chart +
                    '<small>Completion = poles tagged ÷ BOQ target.</small>' + contextNote(ctx);
            }
            // Overview — target scoped to the current filter (whole programme if none).
            const target = boqTargetForScope(ctx);
            let out = '<div class="ai-head">📋 BOQ overview — ' + esc(titleCase(ctx.label)) + '</div>';
            if (target > 0) out += meter(pctOf(actual, target), 'Completion',
                'Poles tagged ' + bold(fmt(actual)) + ' of ' + bold(fmt(target)) + ' target · Remaining ' + bold(fmt(Math.max(0, target - actual))));
            else out += '<div class="ai-row"><em>No BOQ target for this scope.</em> Poles tagged: ' + bold(fmt(actual)) + '</div>';
            if (!ctx.filters.length) {
                // Good/Bad/New are whole-programme BOQ figures, only meaningful unfiltered.
                const good = boqData.reduce((s, d) => s + (parseInt(d['GOOD']) || 0), 0);
                const bad = boqData.reduce((s, d) => s + (parseInt(d['BAD']) || 0), 0);
                const nw = boqData.reduce((s, d) => s + (parseInt(d['NEW POLE']) || 0), 0);
                out += tiles([
                    { val: bold(fmt(target)), label: 'BOQ target' },
                    { val: bold(fmt(good)), label: 'Good (BOQ)' },
                    { val: bold(fmt(bad)), label: 'Bad (BOQ)' },
                    { val: bold(fmt(nw)), label: 'New (BOQ)' },
                ]);
            }
            out += '<small>💡 Ask "feeders behind on BOQ" for the gap by feeder.</small>' + contextNote(ctx);
            return out;
        }

        function countAnswer(q, ctx) {
            const ds = ctx.data;
            if (has(q, /\bdt\b/)) return bold(fmt(uniqCount(ds, 'DT Name'))) + ' unique DTs in ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\bfeeder/)) return bold(fmt(uniqCount(ds, 'Feeder'))) + ' feeders in ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\buser\b/)) return bold(fmt(uniqCount(ds, 'User'))) + ' active field officers in ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\bundertaking\b/)) return bold(fmt(uniqCount(ds, 'Undertaking'))) + ' undertakings in ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\bbusinessunit\b/)) return bold(fmt(uniqCount(ds, 'Bussines Unit'))) + ' business units in ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\bwooden\b/)) { const n = ds.filter(d => norm(d['Type of Pole']).includes('wood')).length; return bold(fmt(n)) + ' wooden poles in ' + esc(ctx.label) + ' (' + pct1(n, ds.length) + ').' + contextNote(ctx); }
            if (has(q, /\bconcrete\b/)) { const n = ds.filter(d => norm(d['Type of Pole']).includes('concrete')).length; return bold(fmt(n)) + ' concrete poles in ' + esc(ctx.label) + ' (' + pct1(n, ds.length) + ').' + contextNote(ctx); }
            if (has(q, /\bbuildings\b/)) return bold(fmt(buildingsStats(ds).total)) + ' buildings connected across ' + esc(ctx.label) + '.' + contextNote(ctx);
            if (has(q, /\bvendor/)) {
                const list = rankEntries(groupCount(ds, d => d.Vendor_Name)).map(([v, c]) => bold(v) + ': ' + fmt(c)).join('<br>');
                return '<div class="ai-head">Vendor breakdown — ' + esc(titleCase(ctx.label)) + '</div>' + list + '<br>Total: ' + bold(fmt(ds.length)) + contextNote(ctx);
            }
            return 'Poles in ' + esc(ctx.label) + ': ' + bold(fmt(poleCount(ds))) +
                (ctx.filters.length ? ' (of ' + fmt(poleCount(globalData)) + ' total).' : '.') + contextNote(ctx);
        }

        function shareAnswer(q, ctx) {
            // "what percentage/share of poles are wooden / linked / carry buildings"
            const ds = ctx.data, n = ds.length;
            const share = (count, what) => '<div class="ai-head">📐 ' + esc(what) + ' — ' + esc(titleCase(ctx.label)) + '</div>' +
                meter(pctOf(count, n), what, bold(fmt(count)) + ' of ' + bold(fmt(n)) + ' poles') + contextNote(ctx);
            if (has(q, /\bwooden\b/)) return share(ds.filter(d => norm(d['Type of Pole']).includes('wood')).length, 'Wooden poles');
            if (has(q, /\bconcrete\b/)) return share(ds.filter(d => norm(d['Type of Pole']).includes('concrete')).length, 'Concrete poles');
            if (has(q, /\blink|associated|building slrn\b/)) return share(linkage(ds).linked, 'Poles with a building SLRN');
            if (has(q, /\bbuildings\b/)) return share(buildingsStats(ds).withB, 'Poles carrying a building');
            return null;
        }

        function listAnswer(q, ctx) {
            const ds = ctx.data, spec = ctx.spec, limit = limitFrom(q, 10);
            let dimKey = null;
            if (has(q, /\bfeeder/)) dimKey = 'feeder';
            else if (has(q, /\bdt\b/)) dimKey = 'dt';
            else if (has(q, /\bundertaking\b/)) dimKey = 'undertaking';
            else if (has(q, /\bbusinessunit\b/)) dimKey = 'businessunit';
            else if (has(q, /\bvendor/)) dimKey = 'vendor';
            else if (has(q, /\buser\b/)) dimKey = 'user';
            if (!dimKey) return null;
            const counts = groupCount(ds, d => d[spec[dimKey].field]);
            const sorted = rankEntries(counts);
            const dispFn = dimKey === 'user' ? (k => esc(getDisplayName(k))) : (k => esc(k));
            const list = sorted.slice(0, limit).map((r, i) => (i + 1) + '. ' + dispFn(r[0]) + ' — ' + bold(fmt(r[1]) + ' poles')).join('<br>');
            return '<div class="ai-head">' + esc(spec[dimKey].label) + 's in ' + esc(titleCase(ctx.label)) + ' (' + sorted.length + ' total)</div>' +
                list + (sorted.length > limit ? '<br><small>…showing top ' + limit + '.</small>' : '') + contextNote(ctx);
        }

        function slrnAnswer(q, rawQuery, data) {
            // Look for an SLRN-like token and match a pole.
            const tokens = rawQuery.toUpperCase().match(/[A-Z]{2,}\d{3,}\d*/g) || [];
            for (const tok of tokens) {
                const rec = data.find(d => String(d['Lt PoleSLRN'] || '').toUpperCase() === tok)
                    || data.find(d => String(d['Lt PoleSLRN'] || '').toUpperCase().includes(tok));
                if (rec) {
                    const bldg = String(rec['Associated Buildings SLRN'] || '').trim();
                    return '<div class="ai-head">📍 Pole ' + esc(rec['Lt PoleSLRN']) + '</div>' +
                        'Type: ' + bold(titleCase(rec['Type of Pole'] || 'Unknown')) + '<br>' +
                        'Feeder: ' + bold(rec['Feeder'] || '—') + '<br>' +
                        'DT: ' + bold(rec['DT Name'] || '—') + '<br>' +
                        'Undertaking: ' + bold(rec['Undertaking'] || '—') + '<br>' +
                        'Buildings connected: ' + bold(rec['No of Buildings Connected to the Pole'] || '0') + '<br>' +
                        'Building SLRN: ' + (bldg ? bold(bldg) : '<em>none linked</em>') + '<br>' +
                        'Tagged by: ' + bold(getDisplayName(rec['User'])) + ' on ' + esc(dayOf(rec) || '—') +
                        (rec['Location address'] ? '<br>Address: ' + esc(rec['Location address']) : '');
                }
            }
            return null;
        }

        function profileAnswer(ctx) {
            // Deep-dive when exactly one entity filter is set.
            if (ctx.filters.length !== 1) return null;
            const f = ctx.filters[0], ds = ctx.data, rr = runRate(ds), bs = buildingsStats(ds), lk = linkage(ds);
            const head = '<div class="ai-head">🔎 ' + esc(ctx.spec[f.dim].label) + ': ' + esc(ctx.spec[f.dim].disp(f.value)) + '</div>';
            if (f.dim === 'user') {
                const vendor = ds[0] ? ds[0].Vendor_Name : '—';
                return head + 'Vendor: ' + bold(vendor) + '<br>' +
                    'Poles tagged: ' + bold(fmt(ds.length)) + ' · run rate ' + bold(rr.rate + '/day') + ' (' + rr.days + ' active days)<br>' +
                    'Buildings connected: ' + bold(fmt(bs.total)) + ' · linkage ' + bold(pct1(lk.linked, lk.n)) + '<br>' +
                    'Undertakings covered: ' + bold(uniqCount(ds, 'Undertaking')) + ' · feeders: ' + bold(uniqCount(ds, 'Feeder'));
            }
            return head + 'Poles: ' + bold(fmt(ds.length)) + ' · run rate ' + bold(rr.rate + '/day') + '<br>' +
                'Field officers: ' + bold(uniqCount(ds, 'User')) + ' · DTs: ' + bold(uniqCount(ds, 'DT Name')) + '<br>' +
                'Buildings: ' + bold(fmt(bs.total)) + ' (avg ' + bs.avg + '/pole) · linkage ' + bold(pct1(lk.linked, lk.n));
        }

        const HELP = '<div class="ai-head">🤖 What I can answer</div>' +
            'I analyse the live pole-tagging data. Try:<br>' +
            '• ' + bold('Summary') + ' or "summary for ETC"<br>' +
            '• ' + bold('Top 10 field officers') + ' / "top feeders by run rate"<br>' +
            '• ' + bold('Run rate by vendor') + ' · ' + bold('Activity last 7 days') + '<br>' +
            '• ' + bold('Concrete vs wooden') + ' · ' + bold('Buildings connected') + '<br>' +
            '• ' + bold('Feeders behind on BOQ') + ' · ' + bold('Building-SLRN linkage') + '<br>' +
            '• A ' + bold('field officer, feeder, DT or SLRN') + ' name for a deep-dive';

        function issueHonestAnswer(ctx) {
            return '<div class="ai-head">⚠️ Condition data not captured</div>' +
                'This dataset records pole <em>tagging</em>, not condition grading — every record is logged as ' + bold('COMPLETE') +
                ', and no defect/quality field is collected. I won\'t invent a defect rate.<br><br>' +
                'What I <em>can</em> tell you for ' + bold(titleCase(ctx.label)) + ':<br>' +
                '• Pole types (concrete vs wooden)<br>• Buildings connected & SLRN linkage<br>• Run rate, coverage and BOQ completion' +
                contextNote(ctx);
        }

        function fallback(q, qTokens, rawQuery, data) {
            // Fuzzy match a user / feeder / DT name, else generic text search.
            const users = [...new Set(data.map(d => d.User).filter(Boolean))];
            const userNames = users.map(getDisplayName);
            const fu = fuzzyBest(qTokens, userNames);
            if (fu) {
                const uid = users.find(u => getDisplayName(u) === fu.value) || fu.value;
                const ds = data.filter(d => d.User === uid);
                if (ds.length) {
                    const rr = runRate(ds), bs = buildingsStats(ds);
                    return '<div class="ai-head">🔎 ' + esc(getDisplayName(uid)) + ' (closest match)</div>' +
                        'Vendor: ' + bold(ds[0].Vendor_Name || '—') + '<br>' +
                        'Poles: ' + bold(fmt(ds.length)) + ' · run rate ' + bold(rr.rate + '/day') + '<br>' +
                        'Buildings: ' + bold(fmt(bs.total)) + ' · undertakings ' + bold(uniqCount(ds, 'Undertaking'));
                }
            }
            const feeders = [...new Set(data.map(d => d.Feeder).filter(Boolean))];
            const ff = fuzzyBest(qTokens, feeders);
            if (ff) {
                const ds = data.filter(d => d.Feeder === ff.value), rr = runRate(ds);
                return '<div class="ai-head">🔌 Feeder ' + esc(ff.value) + ' (closest match)</div>' +
                    'Poles: ' + bold(fmt(ds.length)) + ' · DTs ' + bold(uniqCount(ds, 'DT Name')) +
                    ' · officers ' + bold(uniqCount(ds, 'User')) + ' · run rate ' + bold(rr.rate + '/day');
            }
            // generic text search
            const nq = norm(rawQuery);
            if (nq.length >= 3) {
                const matches = data.filter(d => Object.values(d).some(v => v && String(v).toLowerCase().includes(nq)));
                if (matches.length) {
                    return 'Found ' + bold(fmt(matches.length)) + ' records matching "' + esc(rawQuery) + '" — ' +
                        bold(uniqCount(matches, 'User')) + ' officers, run rate ' + bold(runRate(matches).rate + '/day') + '.';
                }
            }
            return '<div class="ai-head">🤔 I didn\'t catch that</div>' +
                'I couldn\'t map "' + esc(rawQuery) + '" to the data.' + '<br>' + HELP.replace('<div class="ai-head">🤖 What I can answer</div>', '');
        }

        // ---------- main dispatcher ----------
        function runQuery(raw) {
            const rawQuery = String(raw || '').trim();
            if (!rawQuery) { if (thinkTimer) clearTimeout(thinkTimer); responseEl.classList.remove('visible'); return; }
            const data = (Array.isArray(filteredData) && filteredData.length) ? filteredData : globalData;
            if (!data || !data.length) { show('The dashboard is still loading its data — give it a moment, then ask again.'); return; }

            const q = normalize(rawQuery);
            const qTokens = q.split(' ').filter(Boolean);

            // greeting / help
            if (has(q, /^(hi|hello|hey|help|what can you|how do you|examples?)\b/) || q === 'help') { show(HELP); return; }

            // SLRN lookup (before context, so a specific pole isn't mistaken for a filter)
            const slrn = slrnAnswer(q, rawQuery, data);
            if (slrn) { show(slrn); return; }

            const ctx = detectContext(q, qTokens, data);
            if (!ctx.data.length) {
                show('<div class="ai-head">🔍 No records in that scope</div>Nothing matches ' + bold(ctx.label) +
                    ' in the current view. Try clearing a dashboard filter, or ask about a different feeder / officer.');
                return;
            }
            let out = null;

            if (has(q, /\bissue\b/)) out = issueHonestAnswer(ctx);
            // Pole-type before "compare" so "concrete vs wooden" isn't read as a vendor
            // comparison; but let count/percentage phrasing fall through to those handlers.
            else if (has(q, /\bpole ?type|material|concrete|wooden\b/) && !has(q, /\bhow many|count|number of|percent|percentage|share|proportion\b/)) out = poleTypeAnswer(ctx);
            else if (has(q, /\bcompare\b|\bvs\b|\bversus\b|\bdifference\b/)) out = compareAnswer(q, ctx);
            else if (has(q, /\bpercent|percentage|share|proportion|what fraction\b/)) out = shareAnswer(q, ctx);
            // Dashboard vocabulary → the KPI scorecard (mirrors the dashboard cards).
            else if (has(q, /\bkpis?\b|scorecard|score ?card|dashboard\b/)
                || has(q, /\bhow (are|is) (we|things|it) (doing|going)\b/)
                || has(q, /\bnew poles?\b|\bactive users?\b|\btotal poles\b|\boverall (progress|completion|status|score)\b|\bcompletion rate\b/)) out = kpiAnswer(ctx);
            // "behind" (and its kin) only routes to BOQ alongside real BOQ/feeder context,
            // so "which officers are lagging" isn't answered with a feeder-BOQ ranking.
            else if (has(q, /\bboq|target|bill of quant|completion|complete\b/) || (BEHIND_RE.test(q) && has(q, /\bfeeder\b/))) out = boqAnswer(q, ctx);
            else if (has(q, /\btrend|over time|timeline|history|progress|momentum|last \d+ day|per day|daily|this week|yesterday|today\b/)) out = trendAnswer(q, ctx);
            else if (has(q, /\bwhich pole\b|\bbusiest pole\b|\bsingle pole\b/)) out = buildingsAnswer(ctx);
            else if (has(q, /\btop\b|\bbest\b|\bhighest\b|\bmost\b|\bleading\b|\blead\b/)) out = rankAnswer(q, ctx, false);
            else if (has(q, /\bbottom\b|\bworst\b|\blowest\b|\bleast\b|\bslowest\b/)) out = rankAnswer(q, ctx, true);
            else if (has(q, /\brun rate\b/)) out = runRateAnswer(ctx);
            else if (has(q, /\blink|associated building|building slrn|unlinked\b/)) out = linkageAnswer(ctx);
            else if (has(q, /\bbuildings\b/)) out = buildingsAnswer(ctx);
            else if (has(q, /\barea|\blocation|\baddress|\bstreet|\bwhere\b/)) out = rankAnswer('top areas ' + q, ctx, false);
            else if (has(q, /\bsummary|overview|snapshot|status|report|brief|recap|how (are|is) we\b/)) out = summaryAnswer(ctx);
            else if (has(q, /\blist|show me|which\b/)) out = listAnswer(q, ctx);
            else if (has(q, /\bhow many|count|number of|total\b/)) out = countAnswer(q, ctx);

            // Entity-only queries → profile or count.
            if (!out && ctx.filters.length) out = profileAnswer(ctx) || countAnswer(q, ctx);
            if (!out) out = fallback(q, qTokens, rawQuery, data);
            show(out);
        }
    })();

    function updateExecutiveSummary() {
        const container = document.getElementById('exec-dynamic-content');
        if (!container) return;
        const data = filteredData; // empty selection → empty state (consistent with the KPI cards)
        if (!data || data.length === 0) { container.innerHTML = '<p style="color:var(--text-secondary);">No data available.</p>'; return; }

        const total = countUniquePoles(data); // unique SLRN — matches the KPI cards
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

        // Vendors — each pole attributed to one vendor so the bars sum to the total
        const vendorCounts = uniquePolesByGroupExclusive(data, d => d.Vendor_Name || 'Other');
        const sortedVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);
        const vColors = { 'ETC Workforce': '#0EA5E9', 'Jesom Technology': '#f97316', 'Ikeja Electric': '#eab308' };

        // Officers (unique poles per officer)
        const userCounts = uniquePolesByGroup(data, d => d.User);
        const totalUsers = Object.keys(userCounts).length;
        const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
        const topOfficer = sortedUsers[0];

        // Coverage
        const feederCount = new Set(data.map(d => d.Feeder).filter(Boolean)).size;
        const dtCount = new Set(data.map(d => d["DT Name"]).filter(Boolean)).size;
        const utCount = new Set(data.map(d => d.Undertaking).filter(Boolean)).size;
        const buCount = new Set(data.map(d => d["Bussines Unit"]).filter(Boolean)).size;

        // Building-SLRN linkage — a real data-completeness signal (condition/defect
        // grading isn't captured in this dataset, so it isn't reported).
        const link = buildingLinkage(data);
        const linkColor = link.pct >= 80 ? '#10b981' : link.pct >= 60 ? '#eab308' : '#ef4444';

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

        // Pole types (unique poles)
        const poleTypes = uniquePolesByGroup(data, d => (d["Type of Pole"] || 'Unknown').toUpperCase());
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
                <div style="flex:1;height:6px;background:hsl(var(--muted) / 0.45);border-radius:3px;overflow:hidden;">
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
                <div style="height:8px;background:hsl(var(--muted) / 0.45);border-radius:4px;overflow:hidden;">
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
                <div style="background:hsl(var(--secondary) / 0.5);padding:8px 10px;border-radius:6px;border-left:3px solid ${linkColor};">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Building Linkage</div>
                    <div style="font-weight:700;color:${linkColor};">${link.pct.toFixed(1)}% linked <span style="font-weight:400;color:var(--text-secondary);">/ ${fmt(link.unlinked)} to tag</span></div>
                </div>
                <div style="background:hsl(var(--secondary) / 0.5);padding:8px 10px;border-radius:6px;border-left:3px solid hsl(var(--primary));">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Top Officer</div>
                    <div style="font-weight:700;color:hsl(var(--foreground));">${topOfficer ? getDisplayName(topOfficer[0]) : 'N/A'} <span style="font-weight:400;color:var(--text-secondary);">(${topOfficer ? fmt(topOfficer[1]) : 0} poles)</span></div>
                </div>
                <div style="background:hsl(var(--secondary) / 0.5);padding:8px 10px;border-radius:6px;border-left:3px solid #eab308;">
                    <div style="color:var(--text-secondary);font-size:0.75rem;">Dominant Material</div>
                    <div style="font-weight:700;color:hsl(var(--foreground));">${dominantPole ? dominantPole[0].charAt(0) + dominantPole[0].slice(1).toLowerCase() : 'N/A'} <span style="font-weight:400;color:var(--text-secondary);">(${dominantPolePct}%)</span></div>
                </div>
                <div style="background:hsl(var(--secondary) / 0.5);padding:8px 10px;border-radius:6px;border-left:3px solid #f97316;">
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

    // Ikeja Electric system usernames — used to pad the User filter when nothing
    // narrows the scope (so any IE staff can be browsed), shared by the dependent-
    // filter builder and the faceted cascade.
    const IKEJA_USER_ROSTER = [
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
    ];

    // Rebuild the User <select> options from a data subset, preserving the display-
    // name dedup (one entry per name, preferring the id that has records) and the
    // Ikeja roster padding when nothing narrows the scope. Mirrors the User logic in
    // populateDependentFilters so the faceted cascade can rebuild this facet alone.
    function populateUserSelect(data) {
        const userSelect = document.getElementById('userFilter');
        if (!userSelect) return;
        const userSet = new Set(data.map(item => item["User"]));
        const vendorVals = multiSelects.vendorFilter?.getValues();
        const narrowingActive = !!assetLookupQuery ||
            ['dateFilter', 'feederFilter', 'dtFilter', 'buFilter', 'utFilter', 'upriserFilter']
                .some(id => { const v = multiSelects[id]?.getValues(); return Array.isArray(v) && v.length > 0; });
        if (!narrowingActive && (!vendorVals || vendorVals.includes('Ikeja Electric'))) {
            IKEJA_USER_ROSTER.forEach(n => userSet.add(n));
        }
        const usersWithData = new Set(data.map(item => item['User']).filter(Boolean));
        const seenDisplayNames = new Map();
        [...userSet].filter(Boolean).forEach(username => {
            const displayName = getDisplayName(username);
            if (!displayName) return;
            const hasData = usersWithData.has(username);
            const existing = seenDisplayNames.get(displayName);
            if (!existing) seenDisplayNames.set(displayName, { id: username, name: displayName, hasData });
            else if (!existing.hasData && hasData) seenDisplayNames.set(displayName, { id: username, name: displayName, hasData });
        });
        const users = [...seenDisplayNames.values()].sort((a, b) => a.name.localeCompare(b.name));
        userSelect.innerHTML = '<option value="All">All Users</option>';
        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id; opt.textContent = u.name;
            userSelect.appendChild(opt);
        });
    }

    // ── Faceted cascade ──────────────────────────────────────────────────────
    // Selecting any filter narrows every OTHER filter's options to only the values
    // that co-occur with the current selection. Each dropdown is rebuilt from the
    // data matching all OTHER active filters (its own axis is excluded so you can
    // still add more values within it), plus the Asset SLRN lookup. Stale selections
    // are pruned by MultiSelect.refresh().
    const FILTER_FACETS = [
        { id: 'vendorFilter', val: d => d["Vendor_Name"] },
        { id: 'buFilter', val: d => d["Bussines Unit"] },
        { id: 'utFilter', val: d => d["Undertaking"] },
        { id: 'userFilter', val: d => d["User"] },
        { id: 'feederFilter', val: d => d["Feeder"] },
        { id: 'dtFilter', val: d => d["DT Name"] },
        { id: 'upriserFilter', val: d => String(d["UpriserNo"]) },
        { id: 'materialFilter', val: d => (d["Type of Pole"] || '').trim().toUpperCase() },
        { id: 'dateFilter', val: d => (d["Date/timestamp"] || '').split(' ')[0] },
    ];

    // Predicate for one facet's current selection (no selection = pass-all).
    function facetPredicate(facet) {
        const sel = multiSelects[facet.id]?.getValues();
        if (!sel) return () => true;
        const set = new Set(sel);
        return d => set.has(facet.val(d));
    }

    // Records matching every active facet EXCEPT `exceptId`, plus the Asset lookup.
    function dataMatchingFacetsExcept(exceptId) {
        const preds = FILTER_FACETS.filter(f => f.id !== exceptId).map(facetPredicate);
        return globalData.filter(d => {
            if (!matchesAssetLookup(d, assetLookupQuery)) return false;
            for (const p of preds) if (!p(d)) return false;
            return true;
        });
    }

    // Rebuild a plain facet <select> (distinct values, sorted) from a data subset.
    function rebuildFacetOptions(id, valFn, data, allLabel, opts = {}) {
        const sel = document.getElementById(id);
        if (!sel) return;
        const vals = [...new Set(data.map(valFn).filter(Boolean))];
        vals.sort(opts.numeric ? (a, b) => a - b : (a, b) => String(a).localeCompare(String(b)));
        const allValue = opts.allValue != null ? opts.allValue : 'All';
        sel.innerHTML = '<option value="' + allValue + '">' + allLabel + '</option>';
        vals.forEach(v => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = opts.titleCase ? (String(v).charAt(0) + String(v).slice(1).toLowerCase()) : v;
            sel.appendChild(o);
        });
    }

    // Rebuild every filter's options from the other filters, then refresh widgets.
    // Skips the facet the user just changed: its own option list can't be affected
    // by its own selection, and leaving it untouched keeps the open dropdown stable.
    function cascadeAllFilters(changedId) {
        const rebuild = {
            vendorFilter: () => rebuildVendorOptions(dataMatchingFacetsExcept('vendorFilter')),
            feederFilter: () => rebuildFeederOptions(dataMatchingFacetsExcept('feederFilter')),
            dateFilter: () => rebuildDateOptions(dataMatchingFacetsExcept('dateFilter')),
            buFilter: () => rebuildFacetOptions('buFilter', d => d["Bussines Unit"], dataMatchingFacetsExcept('buFilter'), 'All Business Units'),
            utFilter: () => rebuildFacetOptions('utFilter', d => d["Undertaking"], dataMatchingFacetsExcept('utFilter'), 'All Undertakings'),
            dtFilter: () => rebuildFacetOptions('dtFilter', d => d["DT Name"], dataMatchingFacetsExcept('dtFilter'), 'All DTs'),
            upriserFilter: () => rebuildFacetOptions('upriserFilter', d => String(d["UpriserNo"]), dataMatchingFacetsExcept('upriserFilter'), 'All Uprisers', { numeric: true }),
            materialFilter: () => rebuildFacetOptions('materialFilter', d => (d["Type of Pole"] || '').trim().toUpperCase(), dataMatchingFacetsExcept('materialFilter'), 'All Materials', { allValue: '', titleCase: true }),
            userFilter: () => populateUserSelect(dataMatchingFacetsExcept('userFilter')),
        };
        FILTER_FACETS.forEach(f => {
            if (f.id === changedId) return;
            rebuild[f.id]();
            multiSelects[f.id]?.refresh();
        });
    }

    // Single entry point for every filter's change: narrow the others, then redraw.
    function handleFilterChange(changedId) {
        cascadeAllFilters(changedId);
        applyFilters();
    }

    function populateDependentFilters(data, opts = {}) {
        const { skipDate = false, skipFeeder = false } = opts;
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
        if (!skipFeeder) {
            feederSelect.innerHTML = '<option value="All">All Feeders</option>';
        }
        if (!skipDate) {
            dateSelect.innerHTML = '<option value="All">All Dates</option>';
        }

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

        const dts = [...new Set(data.map(item => item["DT Name"]))].filter(Boolean).sort();
        const uprisers = [...new Set(data.map(item => String(item["UpriserNo"] ?? '')).filter(Boolean))].sort((a, b) => a - b);
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
        populateUserSelect(data); // single source of truth for the User dropdown
        populateSelect(dtSelect, dts);
        populateSelect(upriserSelect, uprisers);
        if (!skipFeeder) populateSelect(feederSelect, feeders);
        if (!skipDate) populateSelect(dateSelect, dates);
    }

    // Rebuild the Vendor <select> options from a data subset (keeps "All Vendors").
    function rebuildVendorOptions(data) {
        const sel = document.getElementById('vendorFilter');
        if (!sel) return;
        const vendors = [...new Set(data.map(d => d["Vendor_Name"]).filter(Boolean))].sort();
        sel.innerHTML = '<option value="All">All Vendors</option>';
        vendors.forEach(v => {
            const o = document.createElement('option');
            o.value = v; o.textContent = v; sel.appendChild(o);
        });
    }

    // Rebuild the Feeder <select> options from a data subset (keeps "All Feeders").
    // The feeder cascade deliberately never rebuilds this list, so anything that
    // DOES narrow it (the Asset SLRN lookup) must be able to restore it.
    function rebuildFeederOptions(data) {
        const sel = document.getElementById('feederFilter');
        if (!sel) return;
        const feeders = [...new Set(data.map(d => d["Feeder"]).filter(Boolean))].sort();
        sel.innerHTML = '<option value="All">All Feeders</option>';
        feeders.forEach(f => {
            const o = document.createElement('option');
            o.value = f; o.textContent = f; sel.appendChild(o);
        });
    }

    // Rebuild the Date <select> options from a data subset (keeps "All Dates").
    function rebuildDateOptions(data) {
        const sel = document.getElementById('dateFilter');
        if (!sel) return;
        const dates = [...new Set(data.map(d => (d["Date/timestamp"] || '').split(' ')[0]).filter(Boolean))]
            .sort((a, b) => new Date(b) - new Date(a));
        sel.innerHTML = '<option value="All">All Dates</option>';
        dates.forEach(dt => {
            const o = document.createElement('option');
            o.value = dt; o.textContent = dt; sel.appendChild(o);
        });
    }

    // An Asset SLRN lookup is the narrowest filter there is — it resolves to a
    // single pole (or the handful sharing a building). So every other dropdown
    // is rebuilt from just the matched records: after searching a pole, opening
    // Feeder / DT / User / Date shows only that pole's own context instead of
    // the whole dataset. Clearing the lookup restores the lists from whatever
    // ordinary selections remain.
    function cascadeAssetLookupOptions() {
        // The lookup is just another constraint in the faceted cascade
        // (dataMatchingFacetsExcept applies matchesAssetLookup): while active it
        // narrows every dropdown to the matched pole's context; when cleared it
        // restores the lists from whatever ordinary selections remain.
        cascadeAllFilters();
    }

    // Recompute filteredData from the current slicers + Asset SLRN lookup,
    // WITHOUT redrawing anything. Split out from applyFilters() so the
    // as-you-type lookup can refresh just the table: a full updateDashboard()
    // (eight Plotly charts, the Leaflet map, KPIs, insights and the executive
    // summary) blocks the main thread for ~600ms, which makes typing stutter.
    function computeFilteredData() {
        const vendorVals = multiSelects.vendorFilter?.getValues();
        const buVals = multiSelects.buFilter?.getValues();
        const utVals = multiSelects.utFilter?.getValues();
        const userVals = multiSelects.userFilter?.getValues();
        const dtVals = multiSelects.dtFilter?.getValues();
        const upriserVals = multiSelects.upriserFilter?.getValues();
        const feederVals = multiSelects.feederFilter?.getValues();
        const matVals = multiSelects.materialFilter?.getValues();
        const dateVals = multiSelects.dateFilter?.getValues();

        const assetQ = assetLookupQuery;

        filteredData = globalData.filter(item => {
            const poleType = (item["Type of Pole"] || '').trim().toUpperCase();

            if (!matchesAssetLookup(item, assetQ)) return false;

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
    }

    function applyFilters() {
        computeFilteredData();
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

        // Uploaded poles still awaiting GIS capture (no LT Pole SLRN) are shown on the
        // map/table but must not inflate ANY "captured" tally. The SLRN-keyed KPIs below
        // already exclude them; this subset also keeps them out of the presence counts
        // (Active Users, Feeders, DTs).
        const capturedData = filteredData.filter(d => d.__gisCaptured !== false);

        // Update Top Cards
        const topActiveEl = document.getElementById('topCardActiveUsers');
        if (topActiveEl) {
            const activeUsersCount = new Set(capturedData.map(d => d.User).filter(Boolean)).size;
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
        const actNewCountTop = filteredData.filter(isNewInstallPole).length;
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
            if (isNewInstallPole(item)) {
                const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
                if (slrn) newPoleSLRNs.add(slrn);
            }
        });
        const actNew = newPoleSLRNs.size;

        // --- A2. Total Poles excluding New Poles ---
        const boqRecordsExNew = Math.max(0, boqRecords - boqNew);
        const actRecordsExNew = Math.max(0, actRecords - actNew);
        updateModernCard('records-exnew', boqRecordsExNew, actRecordsExNew);

        // --- B. Building Linkage (real) — poles carrying an associated building SLRN,
        //     unique by pole SLRN. Replaces the old simulated "Good Condition" card. ---
        const linkStats = buildingLinkage(filteredData);
        updateModernCard('concrete', actRecords, linkStats.linked);

        // --- C. Concrete Poles (real) — unique concrete poles by SLRN.
        //     Replaces the old simulated "Bad Poles" card. ---
        const concreteSLRNs = new Set();
        filteredData.forEach(item => {
            if (String(item["Type of Pole"] || "").toUpperCase().includes("CONCRETE")) {
                const slrn = (item["Lt PoleSLRN"] || item["LT Pole No"] || "").toString().trim();
                if (slrn) concreteSLRNs.add(slrn);
            }
        });
        updateModernCard('wooden', actRecords, concreteSLRNs.size);

        updateModernCard('users', boqNew, actNew);

        // --- E. Feeders --- (exclude poles still awaiting GIS capture)
        const boqFeeders = new Set(activeBoqData.map(d => d["FEEDER NAME"])).size;
        const actFeeders = new Set(capturedData.map(d => d.Feeder)).size;
        updateModernCard('feeders', boqFeeders, actFeeders);

        // --- F. DTs --- (exclude poles still awaiting GIS capture)
        const boqDTs = new Set(activeBoqData.map(d => d["DT NAME"])).size;
        const actDTs = new Set(capturedData.map(d => d["DT Name"] || d["DT_Name"])).size;
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

        themedPlot('userPerformanceChart', [trace], layout, { responsive: true });
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

        themedPlot('projectVelocityChart', [traceETC, traceJesom, traceIkeja, traceCumulative], layout, { responsive: true });
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
        const ct = chartTheme();
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
            legend: {
                itemStyle: { color: ct.text },
                itemHoverStyle: { color: ct.text }
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
                            color: ct.text,
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

        themedPlot('staffIssuesChart', traces, layout, { responsive: true });
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

        themedPlot('undertakingChart', [trace], layout, { responsive: true });
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

        themedPlot('vendorTotalChart', [traceTotal], layoutTotal, { responsive: true });

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

        themedPlot('vendorRunRateChart', [traceRunRate], layoutRunRate, { responsive: true });
    }

    function resetFilters() {
        // 1. Reset View Mode first
        viewMode = 'field';
        const toggle = document.getElementById('viewModeToggle');
        if (toggle) toggle.checked = false;

        // 2. Clear Search Input
        const searchInput = document.getElementById('dtSearchInput');
        if (searchInput) searchInput.value = '';

        // 2b. Clear the Asset SLRN lookup and collapse any open drill-downs
        assetLookupQuery = '';
        const assetInput = document.getElementById('assetLookupInput');
        if (assetInput) { assetInput.value = ''; assetInput.classList.remove('has-value'); }
        const assetClear = document.getElementById('assetLookupClear');
        if (assetClear) assetClear.style.display = 'none';
        expandedDTKeys.clear();
        collapsedDTKeys.clear();
        autoExpandActive = false;

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
            if (isNewInstallPole(d)) map[key].newPoles++;

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
                    !multiSelects.materialFilter?.isAll() ||
                    // An Asset SLRN lookup is the most field-dependent filter of
                    // all — padding in every BOQ-only DT would bury the one pole
                    // the user searched for under hundreds of empty rows.
                    !!assetLookupQuery;

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

    // ── DT Drill-Down: Pole Register ─────────────────────────────────────
    // Expanding a DT row reveals its individual poles — the level at which
    // "Lt PoleSLRN" and "Associated Buildings SLRN" actually live. The table
    // above is a DT *aggregate*, so a pole identifier cannot belong in it: one
    // DT row spans hundreds of poles.
    //
    // Repeat captures of the same pole are merged the same way the export does
    // (see mergeDuplicatesBySLRN): building lists are UNIONed so no captured
    // building is ever dropped, and the distinct count is recomputed.
    function getPoleRegister(dtKey) {
        const byPole = new Map();
        let unkeyed = 0;

        filteredData.forEach(d => {
            const feeder = (d["Feeder"] || "Unknown Feeder").trim();
            const dtName = (d["DT Name"] || "Unknown DT").trim();
            if (`${feeder}|${dtName}`.toUpperCase() !== dtKey) return;

            const slrn = String(d["Lt PoleSLRN"] || d["LT Pole No"] || '').trim().toUpperCase();
            const id = slrn || `__unkeyed_${unkeyed++}`;

            let rec = byPole.get(id);
            if (!rec) {
                rec = {
                    slrn: slrn || '—',
                    poleNo: d["LT Pole No"] || '—',
                    // A single pole can carry more than one upriser, so this is
                    // a set rather than a scalar (e.g. IESHLT002500 on 1 and 2).
                    uprisers: new Set(),
                    material: d["Type of Pole"] || '—',
                    status: d["Status"] || '—',
                    user: getDisplayName(d["User"]) || '—',
                    date: d["Date/timestamp"] || '—',
                    declared: 0,
                    buildings: new Set(),
                    captures: 0
                };
                byPole.set(id, rec);
            }

            rec.captures++;
            const up = (d["UpriserNo"] ?? '').toString().trim();
            if (up) rec.uprisers.add(up);
            rec.declared = Math.max(rec.declared, parseInt(d["No of Buildings Connected to the Pole"]) || 0);
            parseBuildings(d["Associated Buildings SLRN"]).forEach(b => rec.buildings.add(b));
        });

        // Ordered by upriser then pole sequence — the order crews walk the line.
        const num = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
        return [...byPole.values()]
            .map(r => {
                const ups = [...r.uprisers].sort((a, b) => num(a, b));
                return { ...r, buildings: [...r.buildings], uprisers: ups, upriser: ups.join(', ') || '—' };
            })
            .sort((a, b) => num(a.uprisers[0] ?? '', b.uprisers[0] ?? '')
                || num(a.poleNo, b.poleNo) || num(a.slrn, b.slrn));
    }

    // Building SLRNs render as chips, collapsed past the third. The widest cell
    // in the dataset holds 31 SLRNs — rendering those raw destroys the row.
    const DRILL_CHIP_LIMIT = 3;

    function buildingChipsHTML(buildings) {
        if (!buildings.length) return '<span class="pole-drill-none">No buildings captured</span>';
        const chip = b => `<button type="button" class="bldg-chip" data-slrn="${b}" title="Filter the dashboard to ${b}">${b}</button>`;
        const shown = buildings.slice(0, DRILL_CHIP_LIMIT);
        const rest = buildings.slice(DRILL_CHIP_LIMIT);
        let html = shown.map(chip).join('');
        if (rest.length) {
            html += `<span class="bldg-chip-rest" hidden>${rest.map(chip).join('')}</span>`;
            html += `<button type="button" class="bldg-chip-more" data-count="${rest.length}">+${rest.length} more</button>`;
        }
        return html;
    }

    function buildPoleRegisterRow(dtRow) {
        const poles = getPoleRegister(dtRow.key);
        const colCount = document.querySelectorAll('#dtTable thead th').length || 15;
        const totalBuildings = poles.reduce((n, p) => n + p.buildings.length, 0);
        // Stored count vs distinct SLRNs — they disagree wherever a cell repeats
        // the same building, which silently inflates "No of Buildings Connected".
        const mismatched = poles.filter(p => p.declared !== p.buildings.length).length;

        const body = poles.length ? poles.map(p => {
            const mismatch = p.declared !== p.buildings.length;
            const warnTitle = mismatch
                ? ` title="Captured count says ${p.declared}, but ${p.buildings.length} distinct SLRN(s) were recorded — the cell repeats a building."`
                : '';
            return `
                <tr>
                    <td><button type="button" class="bldg-chip pole-chip" data-slrn="${p.slrn}" title="Filter the dashboard to ${p.slrn}">${p.slrn}</button>${p.captures > 1 ? `<span class="pr-captures" title="${p.captures} captures of this pole were merged">×${p.captures}</span>` : ''}</td>
                    <td>${p.poleNo}</td>
                    <td style="text-align:center;"${p.uprisers.length > 1 ? ` title="This pole carries ${p.uprisers.length} uprisers"` : ''}>${p.upriser}</td>
                    <td>${p.material}</td>
                    <td style="text-align:center;"><span class="pr-count${mismatch ? ' pr-count-warn' : ''}"${warnTitle}>${p.buildings.length}</span></td>
                    <td class="pr-buildings">${buildingChipsHTML(p.buildings)}</td>
                    <td>${p.status}</td>
                    <td>${p.user}</td>
                    <td class="pr-date">${p.date}</td>
                </tr>`;
        }).join('') : '<tr><td colspan="9" class="pole-drill-none">No pole captures match the current filters.</td></tr>';

        const tr = document.createElement('tr');
        tr.className = 'pole-drill-row';
        tr.dataset.dtkey = dtRow.key;
        tr.innerHTML = `
            <td colspan="${colCount}" class="pole-drill-cell">
                <div class="pole-drill-panel">
                    <div class="pole-drill-head">
                        <span class="pole-drill-title">Pole Register — ${dtRow.dtName}</span>
                        <span class="pole-drill-stats">${poles.length} pole${poles.length === 1 ? '' : 's'} · ${totalBuildings} building${totalBuildings === 1 ? '' : 's'}${mismatched ? ` · <span class="pr-count-warn">${mismatched} count mismatch${mismatched === 1 ? '' : 'es'}</span>` : ''}</span>
                    </div>
                    <div class="pole-drill-scroll">
                        <table class="pole-drill-table">
                            <thead>
                                <tr>
                                    <th>Pole SLRN</th><th>Pole No</th><th>Upriser</th><th>Material</th>
                                    <th>Bldgs</th><th>Associated Buildings SLRN</th>
                                    <th>Status</th><th>Field Officer</th><th>Captured</th>
                                </tr>
                            </thead>
                            <tbody>${body}</tbody>
                        </table>
                    </div>
                </div>
            </td>`;
        return tr;
    }

    // One delegated listener for every drill-down interaction. Bound once —
    // renderDTTable only replaces the tbody's children, never the table itself.
    function initDrillDown() {
        const table = document.getElementById('dtTable');
        if (!table || table.dataset.drillBound) return;
        table.dataset.drillBound = '1';

        table.addEventListener('click', (e) => {
            const toggle = e.target.closest('.dt-drill-toggle');
            if (toggle) {
                const key = toggle.closest('tr')?.dataset.dtkey;
                if (!key) return;
                // While a lookup is auto-opening rows, a click records the
                // exception rather than fighting the auto-expand.
                if (autoExpandActive) {
                    if (collapsedDTKeys.has(key)) collapsedDTKeys.delete(key);
                    else collapsedDTKeys.add(key);
                } else if (expandedDTKeys.has(key)) {
                    expandedDTKeys.delete(key);
                } else {
                    expandedDTKeys.add(key);
                }
                renderDTTable();
                return;
            }

            const more = e.target.closest('.bldg-chip-more');
            if (more) {
                const rest = more.previousElementSibling;
                if (rest && rest.classList.contains('bldg-chip-rest')) {
                    const reveal = rest.hidden;
                    rest.hidden = !reveal;
                    more.textContent = reveal ? 'show less' : `+${more.dataset.count} more`;
                }
                return;
            }

            const chip = e.target.closest('.bldg-chip');
            if (chip && chip.dataset.slrn && chip.dataset.slrn !== '—') applyAssetLookup(chip.dataset.slrn);
        });
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

        // A focused Asset SLRN lookup opens its DT rows automatically — the user
        // searched for one pole/building, so the register IS the answer. While
        // that is on, closing a row records it in collapsedDTKeys instead.
        autoExpandActive = !!assetLookupQuery && totalRows <= AUTO_EXPAND_MAX_DTS;
        const isRowOpen = key => autoExpandActive
            ? !collapsedDTKeys.has(key)
            : expandedDTKeys.has(key);

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

            // Drill-down state for this DT (survives re-renders via the key sets)
            const isOpen = isRowOpen(row.key);
            tr.className = isOpen ? 'dt-row dt-row-open' : 'dt-row';
            tr.dataset.dtkey = row.key;

            // Add classes for column visibility
            tr.innerHTML = `
                <td class="col-index" style="text-align: center;">${globalIndex}</td>
                <td class="col-dtName" style="font-weight: 500; color: hsl(var(--foreground));">
                    <button type="button" class="dt-drill-toggle" aria-expanded="${isOpen}"
                        title="${isOpen ? 'Hide' : 'Show'} the pole register for this DT">
                        <span class="dt-drill-caret">${isOpen ? '&#9662;' : '&#9656;'}</span><span>${row.dtName}</span>
                    </button>
                </td>
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
            if (isOpen) tbody.appendChild(buildPoleRegisterRow(row));
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
        themedPlot('feederChart', [trace], layout, config);
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

            // Map each map-panel filter to its underlying data field.
            const fieldFor = {
                buFilter:     'Bussines Unit',
                utFilter:     'Undertaking',
                feederFilter: 'Feeder',
                dtFilter:     'DT Name',
                vendorFilter: 'Vendor_Name',
                userFilter:   'User'
            };

            // Symmetric faceting: a group's options are the values that co-occur
            // with EVERY other active filter (sidebar or map panel, plus the Asset
            // SLRN lookup), reusing the shared dataMatchingFacetsExcept — so the map
            // panel narrows the same way the sidebar does, not just by "upstream"
            // filters in a fixed order.
            const optionsForFilter = (targetFilterId) => {
                const fld = fieldFor[targetFilterId];
                const out = new Set();
                dataMatchingFacetsExcept(targetFilterId).forEach(d => {
                    const v = d[fld];
                    if (v !== undefined && v !== null && v !== '') out.add(String(v));
                });
                return [...out].sort((a, b) => a.localeCompare(b));
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
                        // Refresh this filter's own sidebar widget (its trigger label
                        // + checkboxes), then fire onChange -> the shared faceted
                        // cascade, which rebuilds/prunes every OTHER filter
                        // symmetrically. Finally re-render this panel to match.
                        if (typeof ms.refresh === 'function') ms.refresh();
                        if (typeof ms.onChange === 'function') ms.onChange();
                        buildPanel();
                        // When the user narrows by BU, UT, Feeder, or DT,
                        // zoom the map to the coverage area of the resulting selection.
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
                url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                opts: { subdomains: 'abcd', maxZoom: 20 }
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
    // ═══════════════════════════════════════════════════════════════════════
    //  DT → connected-pole highlight
    //  Clicking a DT badge lights up every pole tagged under that DT with an
    //  animated (zooming in/out) marker, colour-coded by the vendor that tagged
    //  it: ETC Workforce = blue, Jesom Technology = black, Ikeja Electric =
    //  white. Poles derive from the current filtered set, so the highlight
    //  respects the active filters. Each colour carries a contrasting outline so
    //  black and white stay visible on both the light and dark basemaps.
    // ═══════════════════════════════════════════════════════════════════════
    const VENDOR_HL = {
        'ETC Workforce':    { key: 'blue',  label: 'ETC Workforce' },
        'Jesom Technology': { key: 'black', label: 'Jesom Technology' },
        'Ikeja Electric':   { key: 'white', label: 'Ikeja Electric' }
    };
    const VENDOR_HL_ORDER = ['ETC Workforce', 'Jesom Technology', 'Ikeja Electric'];
    const hlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    function clearDtHighlight() {
        if (dtHighlightLayer) dtHighlightLayer.clearLayers();
        highlightedDtName = null;
        dtHlPoles = []; dtHlCounts = null; dtHlSelected = null; dtHlLegendDiv = null;
        if (dtHighlightControl && map) { map.removeControl(dtHighlightControl); dtHighlightControl = null; }
    }

    function toggleDtHighlight(dtName) {
        if (highlightedDtName === dtName) { clearDtHighlight(); return; }
        renderDtHighlight(dtName);
    }

    function renderDtHighlight(dtName) {
        if (!dtHighlightLayer) return;

        // Collect the DT's poles from the filtered set, deduped by SLRN and
        // gated on valid coordinates — EXACTLY how the DT badge counts them —
        // so the legend total can never diverge from the badge you clicked.
        const seen = new Set();
        const counts = { blue: 0, black: 0, white: 0, other: 0 };
        const poles = [];
        const HL_LIMIT = 2000; // safety cap on animated markers (never hit in practice)
        (filteredData || []).forEach(d => {
            if (poles.length >= HL_LIMIT) return;
            if (String(d['DT Name'] || '').trim() !== dtName) return;
            const lat = parseFloat(d.Latitude), lon = parseFloat(d.Longitude);
            if (isNaN(lat) || isNaN(lon)) return;
            const pid = poleSlrn(d);
            if (!pid) return;               // badge skips SLRN-less rows; match it
            if (seen.has(pid)) return;
            seen.add(pid);
            const info = VENDOR_HL[d.Vendor_Name];
            const key = info ? info.key : 'other';
            counts[key]++;
            poles.push({ lat, lon, key, d }); // keep the record so the marker owns the pole popup
        });

        highlightedDtName = dtName;
        dtHlPoles = poles;
        dtHlCounts = counts;
        // Default selection: every vendor that has at least one pole here.
        dtHlSelected = new Set(Object.keys(counts).filter(k => counts[k] > 0));
        drawDtHighlightMarkers();
        showDtHighlightLegend(dtName);
    }

    // (Re)draw the animated markers for the currently-selected vendors only.
    function drawDtHighlightMarkers() {
        if (!dtHighlightLayer) return 0;
        dtHighlightLayer.clearLayers();
        let shown = 0;
        dtHlPoles.forEach(p => {
            if (!dtHlSelected || !dtHlSelected.has(p.key)) return;
            const marker = L.marker([p.lat, p.lon], {
                icon: L.divIcon({
                    className: 'dt-hl-wrapper',
                    html: `<span class="dt-hl dt-hl-${p.key}"><span class="dt-hl-ring"></span><span class="dt-hl-core"></span></span>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                }),
                zIndexOffset: 1000,
                keyboard: false,
                // The marker is INTERACTIVE and owns the pole popup, so clicking a
                // glowing pole always opens that pole's details (a bigger, reliable
                // target) instead of falling through to the undertaking polygon.
                // bubblingMouseEvents:false keeps the click from clearing the highlight.
                bubblingMouseEvents: false,
                riseOnHover: true
            });
            if (p.d) marker.bindPopup(polePopupHtml(p.d, p.lat, p.lon), {
                className: 'asset-popup-wrapper', maxWidth: 320, minWidth: 260, closeButton: true, autoPan: true
            });
            dtHighlightLayer.addLayer(marker);
            shown++;
        });
        return shown;
    }

    // Click a vendor row to show/hide its poles — independent toggles, so any
    // single vendor or any combination can be shown. Vendors with no poles
    // under this DT are inert.
    function toggleVendorSelection(key) {
        if (!dtHlSelected || !dtHlCounts || !dtHlCounts[key]) return;
        if (dtHlSelected.has(key)) dtHlSelected.delete(key);
        else dtHlSelected.add(key);
        drawDtHighlightMarkers();
        if (dtHlLegendDiv) renderDtHighlightLegendBody(dtHlLegendDiv, highlightedDtName);
    }

    // Legend "Select all" / "Clear" — show every vendor with poles, or none.
    function setDtVendorSelection(selectAll) {
        if (!dtHlSelected || !dtHlCounts) return;
        dtHlSelected = selectAll
            ? new Set(Object.keys(dtHlCounts).filter(k => dtHlCounts[k] > 0))
            : new Set();
        drawDtHighlightMarkers();
        if (dtHlLegendDiv) renderDtHighlightLegendBody(dtHlLegendDiv, highlightedDtName);
    }

    // Render/refresh the legend contents from the current selection state.
    function renderDtHighlightLegendBody(div, dtName) {
        const rowHtml = (label, key) => {
            const c = (dtHlCounts && dtHlCounts[key]) || 0;
            const selected = dtHlSelected && dtHlSelected.has(key);
            const cls = 'dt-hl-legend-row' + (c === 0 ? ' disabled' : '') + (selected ? '' : ' deselected');
            const attrs = c === 0 ? '' : ` role="button" tabindex="0" aria-pressed="${selected ? 'true' : 'false'}"`;
            return `<div class="${cls}" data-key="${key}"${attrs}>
                <span class="dt-hl-swatch dt-hl-swatch-${key}"></span>
                <span class="dt-hl-legend-name">${hlEsc(label)}</span>
                <span class="dt-hl-legend-count">${c.toLocaleString()}</span>
            </div>`;
        };
        // Preserve keyboard focus across the innerHTML rebuild so a keyboard user
        // toggling vendors (or using the action buttons) isn't bounced to <body>.
        const active = document.activeElement;
        const inDiv = div.contains(active);
        const focusedKey = inDiv ? (active.dataset.key || null) : null;
        const focusedAct = inDiv ? (active.dataset.act || null) : null;
        let rows = VENDOR_HL_ORDER.map(v => rowHtml(v, VENDOR_HL[v].key)).join('');
        if (dtHlCounts && dtHlCounts.other) rows += rowHtml('Other vendor', 'other');
        const shown = dtHlPoles.reduce((n, p) => n + (dtHlSelected && dtHlSelected.has(p.key) ? 1 : 0), 0);
        const selectable = dtHlCounts ? Object.keys(dtHlCounts).filter(k => dtHlCounts[k] > 0) : [];
        const allSelected = selectable.length === 0 || selectable.every(k => dtHlSelected && dtHlSelected.has(k));
        const noneSelected = !(dtHlSelected && selectable.some(k => dtHlSelected.has(k)));
        div.innerHTML = `
            <div class="dt-hl-legend-head">
                <span class="dt-hl-legend-title">Connected poles by vendor</span>
                <button class="dt-hl-legend-close" type="button" title="Clear highlight" aria-label="Clear highlight">&times;</button>
            </div>
            <div class="dt-hl-legend-dt">${hlEsc(dtName)}</div>
            <div class="dt-hl-legend-hint">Click a vendor to show / hide its poles</div>
            ${rows}
            <div class="dt-hl-legend-actions">
                <button type="button" class="dt-hl-legend-act" data-act="all"${allSelected ? ' disabled' : ''}>Select all</button>
                <button type="button" class="dt-hl-legend-act" data-act="clear"${noneSelected ? ' disabled' : ''}>Clear</button>
            </div>
            <div class="dt-hl-legend-total"><span class="dt-hl-legend-total-num">${shown.toLocaleString()}</span> of ${dtHlPoles.length.toLocaleString()} pole${dtHlPoles.length === 1 ? '' : 's'} shown</div>
        `;
        div.querySelector('.dt-hl-legend-close').addEventListener('click', clearDtHighlight);
        div.querySelectorAll('.dt-hl-legend-row[role="button"]').forEach(row => {
            const act = () => toggleVendorSelection(row.dataset.key);
            row.addEventListener('click', act);
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
        });
        div.querySelectorAll('.dt-hl-legend-act').forEach(btn => {
            btn.addEventListener('click', () => setDtVendorSelection(btn.dataset.act === 'all'));
        });
        if (focusedKey) div.querySelector(`.dt-hl-legend-row[data-key="${focusedKey}"]`)?.focus();
        else if (focusedAct) div.querySelector(`.dt-hl-legend-act[data-act="${focusedAct}"]:not(:disabled)`)?.focus();
    }

    function showDtHighlightLegend(dtName) {
        if (dtHighlightControl && map) { map.removeControl(dtHighlightControl); dtHighlightControl = null; }
        const Ctrl = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                const div = L.DomUtil.create('div', 'dt-hl-legend');
                dtHlLegendDiv = div;
                renderDtHighlightLegendBody(div, dtName);
                // Clicks/scroll on the legend must not reach the map (which would
                // clear the highlight or pan) — the rows handle their own clicks.
                // disableClickPropagation only stops mousedown/dblclick, so also
                // stop the 'click' itself, or a row click bubbles to map.on('click').
                L.DomEvent.disableClickPropagation(div);
                L.DomEvent.disableScrollPropagation(div);
                L.DomEvent.on(div, 'click', L.DomEvent.stopPropagation);
                return div;
            }
        });
        dtHighlightControl = new Ctrl();
        map.addControl(dtHighlightControl);
    }

    // Shared pole popup — used by the base pole markers AND the DT-highlight
    // markers, so a highlighted pole shows the same details when clicked.
    function polePopupHtml(d, lat, lon) {
        const val = (v) => (v === undefined || v === null || v === '') ? 'N/A' : hlEsc(String(v));
        const poleSLRN = val(d["Lt PoleSLRN"]);
        const poleID = val(d["LT Pole ID"] || d["LT Pole No"]);
        const officer = val(getDisplayName(d["User"]) || d["User"]);
        const latStr = (typeof lat === 'number' && !isNaN(lat)) ? lat.toFixed(6) : val(d["Latitude"]);
        const lonStr = (typeof lon === 'number' && !isNaN(lon)) ? lon.toFixed(6) : val(d["Longitude"]);
        return `
            <div class="asset-popup">
                <div class="asset-popup-title">${poleSLRN}</div>
                <div class="asset-popup-subtitle">TAGGED POLE</div>
                <div class="asset-popup-divider"></div>
                <div class="asset-popup-table">
                    <div class="asset-popup-row"><div class="asset-popup-label">Business Unit</div><div class="asset-popup-value">${val(d["Bussines Unit"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Undertaking</div><div class="asset-popup-value">${val(d["Undertaking"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Upriser No</div><div class="asset-popup-value">${val(d["UpriserNo"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Feeder Name</div><div class="asset-popup-value">${val(d["Feeder"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">DT Name</div><div class="asset-popup-value">${val(d["DT Name"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Pole SLRN</div><div class="asset-popup-value">${poleSLRN}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Pole ID</div><div class="asset-popup-value">${poleID}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Field Officer</div><div class="asset-popup-value">${officer}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Vendor</div><div class="asset-popup-value">${val(d["Vendor_Name"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Address</div><div class="asset-popup-value">${val(d["Location address"])}</div></div>
                    <div class="asset-popup-row"><div class="asset-popup-label">Latitude</div><div class="asset-popup-value">${latStr}</div></div>
                    <div class="asset-popup-row asset-popup-row-last"><div class="asset-popup-label">Longitude</div><div class="asset-popup-value">${lonStr}</div></div>
                </div>
            </div>
        `;
    }

    function renderMap() {
        if (!map) {
            // Init map — default view centers on Lagos; boundary fit will take over once loaded
            map = L.map('map', { zoomControl: true }).setView([6.55, 3.45], 10);

            // Base layers — Dark (default) & Light (CartoDB), Google Satellite/Hybrid.
            const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                maxZoom: 20
            });
            const lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
                maxZoom: 20
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
            mapBases = { dark: darkLayer, light: lightLayer, satellite: satLayer, hybrid: hybridLayer };
            // Default the basemap to match the dashboard theme (dark by default).
            const wantLight = document.documentElement.getAttribute('data-theme') === 'light';
            (wantLight ? lightLayer : darkLayer).addTo(map);
            mapLayersControl = L.control.layers(
                { 'Dark': darkLayer, 'Light': lightLayer, 'Satellite': satLayer, 'Hybrid': hybridLayer },
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
            dtLayer = L.layerGroup().addTo(map);   // DT centroids sit above pole dots

            // Expose the DT layer as a toggleable overlay so users can hide the
            // transformer badges when they want an unobstructed pole view.
            if (mapLayersControl) {
                mapLayersControl.addOverlay(dtLayer, '<span class="dt-legend-swatch"></span>Distribution Transformers');
            }

            // Animated highlight of the poles connected to a clicked DT (sits on
            // top of everything). Clears on empty-map click or Escape.
            dtHighlightLayer = L.layerGroup().addTo(map);
            map.on('click', () => clearDtHighlight());
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearDtHighlight(); });

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
        clearDtHighlight(); // a filter/theme re-render invalidates any active highlight
        let count = 0;
        const limit = 3000; // Performance limit for rendered markers
        const dataLatLngs = []; // ALL valid filtered points (used to frame the map)

        filteredData.forEach(d => {
            const lat = parseFloat(d.Latitude);
            const lon = parseFloat(d.Longitude);

            if (!isNaN(lat) && !isNaN(lon)) {
                dataLatLngs.push([lat, lon]); // collect every point for bounds (uncapped)
                if (count > limit) return;    // cap only the number of drawn markers
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
                    className: 'data-point-marker', // enables CSS pulse animation
                    bubblingMouseEvents: false     // a pole click must not reach the map 'click' (which clears a DT highlight)
                });

                marker.bindPopup(polePopupHtml(d, lat, lon), {
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

        // ═══════════════════════════════════════════════════════════════
        // Distribution Transformers — derived-centroid animated markers
        // A DT has no coordinate of its own in the field data, so each DT's
        // map position is the centroid (mean lat/long) of its tagged poles in
        // the *current* filtered set. Because they are computed from
        // filteredData, the DT badges appear, disappear and drift in step with
        // every filter change — no separate wiring needed.
        // ═══════════════════════════════════════════════════════════════
        if (dtLayer) {
            dtLayer.clearLayers();
            const dtGroups = new Map();
            filteredData.forEach(d => {
                const name = String(d["DT Name"] || '').trim();
                if (!name) return;
                const lat = parseFloat(d.Latitude);
                const lon = parseFloat(d.Longitude);
                if (isNaN(lat) || isNaN(lon)) return;
                let g = dtGroups.get(name);
                if (!g) {
                    g = {
                        name,
                        dtNo: String(d["DT Number"] || d["DT No"] || d["DTNumber"] || '').trim(),
                        feeder: String(d["Feeder"] || '').trim(),
                        undertaking: String(d["Undertaking"] || '').trim(),
                        bu: String(d["Bussines Unit"] || '').trim(),
                        sumLat: 0, sumLon: 0, n: 0, poles: new Set(), uprisers: new Set()
                    };
                    dtGroups.set(name, g);
                }
                g.sumLat += lat;
                g.sumLon += lon;
                g.n++;
                const pid = poleSlrn(d);
                if (pid) g.poles.add(pid);
                // A DT can span several uprisers — collect the distinct numbers.
                const up = String(d["UpriserNo"] ?? '').trim();
                if (up) g.uprisers.add(up);
            });

            // Draw the biggest DTs first, and cap the count so dense filters
            // don't paper the map with hundreds of overlapping badges.
            const DT_LIMIT = 600;
            const dtList = Array.from(dtGroups.values())
                .sort((a, b) => (b.poles.size || b.n) - (a.poles.size || a.n));
            const dtShown = Math.min(dtList.length, DT_LIMIT);

            const escHtml = (s) => String(s).replace(/[&<>"]/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
            ));

            for (let i = 0; i < dtShown; i++) {
                const g = dtList[i];
                const clat = g.sumLat / g.n;
                const clon = g.sumLon / g.n;
                // Count unique pole SLRNs only — the SAME basis the highlight
                // legend uses — so the badge and legend totals can never diverge.
                const poleCount = g.poles.size;
                // A DT with captures but no identifiable poles (all SLRN-less)
                // has nothing to badge or highlight — skip it entirely.
                if (poleCount === 0) continue;
                // Distinct upriser numbers for this DT, sorted numerically.
                const upriserStr = [...g.uprisers]
                    .sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0))
                    .join(', ');
                const badge = poleCount > 999 ? '999+' : String(poleCount);

                const marker = L.marker([clat, clon], {
                    icon: L.divIcon({
                        className: 'dt-marker-wrapper',
                        html: `
                            <div class="dt-marker">
                                <span class="dt-marker-ring"></span>
                                <span class="dt-marker-core">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#052e2b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                                </span>
                                <span class="dt-marker-badge">${badge}</span>
                            </div>
                        `,
                        iconSize: [30, 30],
                        iconAnchor: [15, 15]
                    }),
                    zIndexOffset: 300
                });

                marker.bindTooltip(escHtml(g.name), { direction: 'top', offset: [0, -14], className: 'dt-tooltip' });

                const row = (lbl, v) => v ? `<div class="asset-popup-row"><div class="asset-popup-label">${lbl}</div><div class="asset-popup-value">${escHtml(v)}</div></div>` : '';
                marker.bindPopup(`
                    <div class="asset-popup">
                        <div class="asset-popup-title">${escHtml(g.name)}</div>
                        <div class="asset-popup-subtitle">DISTRIBUTION TRANSFORMER</div>
                        <div class="asset-popup-divider"></div>
                        <div class="asset-popup-table">
                            ${row('Business Unit', g.bu)}
                            ${row('Undertaking', g.undertaking)}
                            ${row('Feeder Name', g.feeder)}
                            ${row('DT Number', g.dtNo)}
                            ${row('Upriser', upriserStr)}
                            <div class="asset-popup-row"><div class="asset-popup-label">Tagged Poles</div><div class="asset-popup-value">${poleCount.toLocaleString()}</div></div>
                            <div class="asset-popup-row asset-popup-row-last"><div class="asset-popup-label">Centroid</div><div class="asset-popup-value">${clat.toFixed(5)}, ${clon.toFixed(5)}</div></div>
                        </div>
                    </div>
                `, { className: 'asset-popup-wrapper', maxWidth: 320, minWidth: 250 });

                // Click a DT to light up its connected poles (colour = vendor).
                marker.on('click', () => toggleDtHighlight(g.name));

                dtLayer.addLayer(marker);
            }

            if (dtList.length > DT_LIMIT) {
                console.info(`Map: showing top ${DT_LIMIT} of ${dtList.length} DTs (by pole count) to limit clutter.`);
            }
        }

        // Refresh search suggestions whenever data is re-rendered
        if (typeof window._refreshMapSearchSuggestions === 'function') {
            window._refreshMapSearchSuggestions();
        }

        // Frame the map to a wide Lagos-State regional view on first render,
        // so the user can see the whole operating area (Lagos + neighbouring
        // states + the UT polygons) before drilling in.
        // Signature of the current filtered set — lets us re-frame the map ONLY
        // when the filter actually changed (not on theme / view-mode re-renders).
        const lastRow = filteredData.length ? filteredData[filteredData.length - 1] : null;
        const idOf = r => r ? (r['Lt PoleSLRN'] || r['LT Pole No'] || '') : '';
        const filterSig = filteredData.length + '|' + idOf(filteredData[0]) + '|' + idOf(lastRow);

        if (!mapInitiallyFitted) {
            try {
                // Lagos State centroid, wide regional zoom level
                map.flyTo([6.55, 3.55], 8, {
                    duration: 2.8,
                    easeLinearity: 0.25
                });
            } catch (e) {
                console.warn("flyTo failed", e);
                map.setView([6.55, 3.55], 8);
            }
            mapInitiallyFitted = true;
            lastMapFilterSig = filterSig;
            startMarkerPulse(20000);
        } else {
            // Re-frame the map whenever the filtered set changed, so it always
            // visibly reflects the current selection. Skip when nothing changed
            // (theme toggle / view-mode re-render) to avoid gratuitous panning.
            if (filterSig !== lastMapFilterSig) {
                lastMapFilterSig = filterSig;
                // The Asset SLRN lookup counts as an active filter. Without it a
                // search selects none of the nine slicers, so this fell through
                // to the overview branch and zoomed OUT to the whole of Lagos —
                // the opposite of finding the pole you just searched for.
                const filtersActive = !!assetLookupQuery ||
                    ['vendorFilter', 'buFilter', 'utFilter', 'userFilter', 'feederFilter', 'dtFilter', 'upriserFilter', 'materialFilter', 'dateFilter']
                        .some(id => multiSelects[id] && !multiSelects[id].isAll());
                try {
                    map.invalidateSize(); // ensure the container size is current before framing
                    if (assetLookupQuery && dataLatLngs.length) {
                        // A SLRN search resolves to one pole (or the few sharing
                        // a building), so go right to it and mark it — the same
                        // pulsing halo the map's own search box uses for a hit.
                        const b = L.latLngBounds(dataLatLngs);
                        // Repeat captures of one pole sit metres apart, so a tiny
                        // bounding box still means "one pole".
                        const spanM = b.getNorthEast().distanceTo(b.getSouthWest());
                        if (dataLatLngs.length === 1 || spanM < 60) {
                            const c = b.getCenter();
                            // Frame synchronously first — an animated flyTo can
                            // be cancelled inside the render cycle, which is why
                            // the branch below uses fitBounds. The halo (which
                            // does fly) is started just after, out of the cycle.
                            map.setView([c.lat, c.lng], 18);
                            setTimeout(() => highlightSearchTarget(c.lat, c.lng), 0);
                        } else {
                            map.fitBounds(b, { padding: [60, 60], maxZoom: 18 });
                        }
                    } else if (filtersActive && dataLatLngs.length) {
                        // Snap to the filtered points (synchronous fitBounds is reliable
                        // inside the render cycle; an animated flyTo can get cancelled).
                        clearSearchHighlight();
                        map.fitBounds(L.latLngBounds(dataLatLngs), { padding: [40, 40], maxZoom: 16 });
                    } else if (!filtersActive) {
                        // No filters -> return to the wide regional overview.
                        clearSearchHighlight();
                        map.setView([6.55, 3.55], 8);
                    }
                } catch (e) { console.warn('map reframe failed', e); }
            }
            if (count > 0) startMarkerPulse(20000);
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
    // Remove the pulsing halo and stop its zoom oscillation. Called before
    // starting a new highlight, and when a search is cleared — otherwise the
    // halo keeps pulsing over an empty map for the rest of its 20s life.
    function clearSearchHighlight() {
        if (searchHighlightLayer && map) { map.removeLayer(searchHighlightLayer); }
        searchHighlightLayer = null;
        if (searchHighlightInterval) { clearInterval(searchHighlightInterval); searchHighlightInterval = null; }
        if (searchHighlightTimeout) { clearTimeout(searchHighlightTimeout); searchHighlightTimeout = null; }
    }

    function highlightSearchTarget(lat, lon) {
        if (!map) return;
        clearSearchHighlight();

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

                    // An undertaking spans many feeders/DTs/vendors/officers, so
                    // show an AGGREGATE summary — not one pole's fields. (The old
                    // version picked each field independently via first-non-empty,
                    // so Feeder/DT/Vendor/User could each come from a different
                    // pole, e.g. showing a single vendor for a multi-vendor area.)
                    const buildUtPopup = () => {
                        const utRows = (filteredData || []).filter(r => (r["Undertaking"] || '').toString().toUpperCase() === name.toUpperCase());
                        const buVal = bu || (utRows.find(r => r["Bussines Unit"]) || {})["Bussines Unit"] || 'N/A';
                        const row = (lbl, val, last) => `<div class="asset-popup-row${last ? ' asset-popup-row-last' : ''}"><div class="asset-popup-label">${lbl}</div><div class="asset-popup-value">${val}</div></div>`;
                        if (!utRows.length) {
                            return `<div class="asset-popup"><div class="asset-popup-title">${hlEsc(name) || 'N/A'}</div><div class="asset-popup-subtitle">UNDERTAKING</div><div class="asset-popup-divider"></div><div class="asset-popup-table">${row('Business Unit', hlEsc(buVal))}${row('Poles Tagged', 'None in the current filter', true)}</div></div>`;
                        }
                        const poles = countUniquePoles(utRows);
                        const feeders = new Set(utRows.map(r => r.Feeder).filter(Boolean)).size;
                        const dts = new Set(utRows.map(r => r["DT Name"]).filter(Boolean)).size;
                        const officers = new Set(utRows.map(r => r.User).filter(Boolean)).size;
                        const vendorCounts = uniquePolesByGroupExclusive(utRows, r => r.Vendor_Name || 'Other');
                        const vendorStr = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1])
                            .map(([v, c]) => `${hlEsc(v)} (${c.toLocaleString()})`).join('<br>') || 'N/A';
                        return `
                            <div class="asset-popup">
                                <div class="asset-popup-title">${hlEsc(name) || 'N/A'}</div>
                                <div class="asset-popup-subtitle">UNDERTAKING</div>
                                <div class="asset-popup-divider"></div>
                                <div class="asset-popup-table">
                                    ${row('Business Unit', hlEsc(buVal))}
                                    ${row('Feeders', feeders.toLocaleString())}
                                    ${row('Distribution Transformers', dts.toLocaleString())}
                                    ${row('Poles Tagged', poles.toLocaleString())}
                                    ${row('Field Officers', officers.toLocaleString())}
                                    ${row('Vendors', vendorStr, true)}
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
                            html: `<div class="ut-label" style="border-color:${col};">${hlEsc(name)}</div>`,
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
        if (data.length === 0) { container.innerHTML = '<p style="color:var(--text-secondary);">No data to display.</p>'; return; }
        const total = countUniquePoles(data); // unique SLRN — matches the KPI cards

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

        // --- Vendor race — each pole attributed to one vendor (sums to total) ---
        const vendorCounts = uniquePolesByGroupExclusive(data, d => d.Vendor_Name || 'Other');
        const sortedVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]);
        const vendorColors = { 'ETC Workforce': '#0EA5E9', 'Jesom Technology': '#f97316', 'Ikeja Electric': '#eab308' };

        // --- Officers (unique poles) ---
        const userCounts = uniquePolesByGroup(data, d => d.User);
        const totalUsers = Object.keys(userCounts).length;

        // --- Building-SLRN linkage (real data-completeness signal) ---
        const link = buildingLinkage(data);
        const linkPct = link.pct.toFixed(1);
        const linkColor = link.pct >= 80 ? '#10b981' : link.pct >= 60 ? '#eab308' : '#ef4444';

        // --- Coverage ---
        const feederCount = new Set(data.map(d => d.Feeder).filter(Boolean)).size;
        const dtCount = new Set(data.map(d => d["DT Name"]).filter(Boolean)).size;
        const utCount = new Set(data.map(d => d.Undertaking).filter(Boolean)).size;

        // --- BOQ completion (scope the target by the active feeder/DT filter, so it
        //     matches the KPI cards and exec summary instead of dividing by the whole BOQ) ---
        let kiBoqData = boqData;
        const kiFeederVals = multiSelects.feederFilter?.getValues();
        if (kiFeederVals && kiFeederVals.length > 0) kiBoqData = kiBoqData.filter(d => kiFeederVals.includes(d["FEEDER NAME"]));
        const kiDtVals = multiSelects.dtFilter?.getValues();
        if (kiDtVals && kiDtVals.length > 0) kiBoqData = kiBoqData.filter(d => kiDtVals.includes(d["DT NAME"]));
        const boqTotal = kiBoqData.length > 0 ? kiBoqData.reduce((s, d) => s + (parseInt(d["POLES Grand Total"]) || 0), 0) : 0;
        const completionPct = boqTotal > 0 ? Math.min(((total / boqTotal) * 100), 100).toFixed(1) : null;

        // --- Pole types (unique poles) ---
        const poleTypes = uniquePolesByGroup(data, d => (d["Type of Pole"] || 'Unknown').toUpperCase());
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

            <!-- Building-SLRN Linkage -->
            <div class="insight-item" style="flex-direction:column;align-items:stretch;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="insight-label">Building Linkage</span>
                    <span style="font-size:0.85rem;font-weight:600;color:${linkColor};">${linkPct}% linked</span>
                </div>
                <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;background:hsl(var(--muted) / 0.45);">
                    <div style="width:${linkPct}%;background:${linkColor};"></div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-top:3px;">
                    <span style="color:hsl(var(--foreground));">${link.linked.toLocaleString()} linked</span>
                    <span style="color:var(--text-secondary);">${link.unlinked.toLocaleString()} to tag</span>
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
        const ct = chartTheme();
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
                style: { fontSize: '12px', colors: [ct.text] }
            },
            stroke: { show: true, width: 1, colors: ['#fff'] },
            xaxis: { title: { text: 'Number of Poles', style: { color: ct.muted } }, labels: { style: { colors: ct.muted } } },
            yaxis: { labels: { style: { colors: ct.text } } },
            theme: { mode: ct.mode },
            grid: { borderColor: ct.grid }
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
            // BOQ condition profile per DT (real BOQ survey figures). The field
            // "actual good/bad" split isn't captured, so it isn't shown here.
            series: [
                { name: 'Good (BOQ)', data: topDTs.map(d => d.boqGood) },
                { name: 'Bad — Replace (BOQ)', data: topDTs.map(d => d.boqBad) }
            ],
            chart: { type: 'bar', height: 400, toolbar: { show: false }, background: 'transparent' },
            colors: ['#10b981', '#ef4444'], // Good = green, Bad = red
            plotOptions: {
                bar: { horizontal: false, columnWidth: '55%', endingShape: 'rounded' }
            },
            dataLabels: { enabled: false },
            xaxis: { categories: dtLabels, labels: { style: { colors: ct.muted } } },
            yaxis: { title: { text: 'Count', style: { color: ct.muted } }, labels: { style: { colors: ct.muted } } },
            theme: { mode: ct.mode },
            grid: { borderColor: ct.grid },
            legend: { labels: { colors: ct.text } }
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

        // Use filteredData so cards react to filter changes (empty selection → empty cards,
        // consistent with the KPI cards, rather than silently showing the whole project).
        const activeData = filteredData;
        const globalTotal = countUniquePoles(activeData);
        const globalLinkPct = buildingLinkage(activeData).pct; // project-wide building-SLRN linkage
        // Each pole attributed to one vendor, so per-vendor totals sum to globalTotal and
        // match the exec-summary / key-insights vendor bars.
        const vendorPoleCounts = uniquePolesByGroupExclusive(activeData, d => d.Vendor_Name || 'Other');

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
            const totalRecords = vendorPoleCounts[vendor] || 0; // one pole → one vendor (sums to total)
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

            // Users (unique poles per officer)
            const userCounts = uniquePolesByGroup(vData, d => d.User);
            const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
            const totalUsers = sortedUsers.length;
            const topUser = sortedUsers[0];
            const bottomUser = sortedUsers[sortedUsers.length - 1];
            const topUserName = topUser ? getDisplayName(topUser[0]) : 'N/A';
            const bottomUserName = bottomUser ? getDisplayName(bottomUser[0]) : 'N/A';
            const avgPerUser = totalUsers > 0 ? Math.round(totalRecords / totalUsers) : 0;

            // Top user contribution %
            const topUserPct = topUser ? ((topUser[1] / totalRecords) * 100).toFixed(1) : 0;

            // Undertakings & concentration (unique poles per undertaking)
            const utCounts = uniquePolesByGroup(vData, d => d.Undertaking);
            const sortedUTs = Object.entries(utCounts).sort((a, b) => b[1] - a[1]);
            const activeUTs = sortedUTs.length;
            const topUT = sortedUTs[0];
            const bottomUT = sortedUTs[sortedUTs.length - 1];
            const topUtPct = topUT ? ((topUT[1] / totalRecords) * 100).toFixed(0) : 0;

            // DTs
            const dtCount = new Set(vData.map(d => d["DT Name"])).size;
            const feederCount = new Set(vData.map(d => d.Feeder)).size;

            // Building-SLRN linkage & connected buildings (real data-completeness signals)
            const link = buildingLinkage(vData);
            const linkPct = link.pct;
            const linkDiff = (linkPct - globalLinkPct).toFixed(1);
            const linkAboveAvg = parseFloat(linkDiff) >= 0;
            const buildingsConnected = uniqueBuildings(vData);
            const avgBuildingsPerPole = totalRecords > 0 ? (buildingsConnected / totalRecords).toFixed(2) : '0.00';

            // Data freshness
            const lastDateObj = lastDateISO ? new Date(lastDateISO) : new Date();
            const diffDays = Math.ceil(Math.abs(new Date() - lastDateObj) / (1000 * 60 * 60 * 24));

            // Completion vs BOQ
            const completionPct = boqTotal > 0 ? ((totalRecords / boqTotal) * 100).toFixed(1) : null;

            // --- STATUS DETERMINATION (multi-factor) ---
            let statusScore = 0;
            if (avgRate >= TARGET_RATE) statusScore += 2;
            else if (avgRate >= 35) statusScore += 1;
            if (linkPct >= globalLinkPct) statusScore += 1;
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

            // 4. Data Completeness & Coverage (building-SLRN linkage — a real signal)
            const linkCompare = linkAboveAvg
                ? `<strong>${Math.abs(parseFloat(linkDiff))} pts above</strong> the project average of ${globalLinkPct.toFixed(1)}%`
                : `<strong>${Math.abs(parseFloat(linkDiff))} pts below</strong> the project average of ${globalLinkPct.toFixed(1)}%`;
            if (linkPct < 60) {
                recs.push({
                    icon: '🔗', title: 'Data Completeness Gap — Building Tagging',
                    text: `Only <strong>${linkPct.toFixed(1)}% of poles</strong> carry an associated building SLRN ` +
                        `(${link.linked.toLocaleString()} linked, <strong>${link.unlinked.toLocaleString()} unlinked</strong>) — ${linkCompare}. ` +
                        `${buildingsConnected.toLocaleString()} buildings connected so far (avg ${avgBuildingsPerPole}/pole). ` +
                        `Prioritise building-tagging on the ${link.unlinked.toLocaleString()} unlinked poles to complete the customer-to-asset mapping.`
                });
            } else if (linkPct >= 85) {
                recs.push({
                    icon: '✅', title: 'Strong Data Completeness',
                    text: `<strong>${linkPct.toFixed(1)}% of poles</strong> are linked to a building SLRN ` +
                        `(${link.linked.toLocaleString()} of ${totalRecords.toLocaleString()}) — ${linkCompare}. ` +
                        `${buildingsConnected.toLocaleString()} buildings connected (avg ${avgBuildingsPerPole}/pole). ` +
                        `${link.unlinked > 0 ? `Close out the remaining ${link.unlinked.toLocaleString()} unlinked poles to reach full coverage.` : 'Every captured pole is linked — excellent completeness.'}`
                });
            } else {
                recs.push({
                    icon: '🔗', title: 'Building-SLRN Linkage & Coverage',
                    text: `<strong>${linkPct.toFixed(1)}% of poles</strong> carry a building SLRN ` +
                        `(${link.linked.toLocaleString()} linked, ${link.unlinked.toLocaleString()} unlinked) — ${linkCompare}. ` +
                        `${buildingsConnected.toLocaleString()} buildings connected (avg ${avgBuildingsPerPole}/pole). ` +
                        `${linkAboveAvg ? 'Above the project norm — maintain the tagging discipline.' : 'Below the project norm — schedule follow-up tagging on unlinked poles.'}`
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

    // ── Asset SLRN Lookup ────────────────────────────────────────────────
    // A typeahead over the pole/building index. Unlike the nine slicers beside
    // it this is an *identifier* lookup — ~25k distinct IDs cannot be browsed in
    // a dropdown — so the user types and we resolve. Entering a Building SLRN
    // filters the dashboard to the LT pole that building is connected to, which
    // is the reverse direction the dashboard could not answer before.
    //
    // The filter commits on Enter or on picking a suggestion (not on every
    // keystroke) because each commit re-filters 11k rows and redraws every
    // chart and the map.
    function initAssetLookup() {
        const input = document.getElementById('assetLookupInput');
        const clearBtn = document.getElementById('assetLookupClear');
        const list = document.getElementById('assetLookupSuggestions');
        if (!input || !list || !clearBtn) return;

        let liveTimer = null;      // as-you-type filter (table only)
        let settleTimer = null;    // full redraw + jump, once typing stops
        let lastScrolledFor = null;
        let lastFullQuery = null;  // query the heavy redraw last ran for
        let focusIndex = -1;

        // Every SLRN starts "IESH", so anything shorter than this matches the
        // whole dataset — filtering on it is a full re-render that changes
        // nothing. Below the threshold we treat the box as empty.
        const MIN_LIVE_CHARS = 4;

        const closeList = () => { list.style.display = 'none'; focusIndex = -1; };

        // Push a value at the dashboard. Split out from commit() so the live
        // as-you-type path can filter WITHOUT scrolling — the filter bar is not
        // sticky, so jumping to the table mid-keystroke would pull this very
        // input off-screen while the user is still typing into it.
        // opts.light: refresh only the table. Used while typing — the charts,
        // map and KPIs are off-screen anyway and cost ~600ms of blocked main
        // thread per pass, which would make the box feel frozen. The full
        // redraw (and the slicer cascade) runs once typing stops.
        const applyAssetQuery = (q, opts = {}) => {
            if (q === assetLookupQuery) return;
            assetLookupQuery = q;
            input.classList.toggle('has-value', !!q);
            currentPage = 1;
            collapsedDTKeys.clear();   // every new search starts fully open
            if (opts.light) {
                computeFilteredData();
                renderDTTable();
                return;
            }
            cascadeAssetLookupOptions();
            applyFilters();
            if (opts.scroll && q) revealSearchResult();
        };

        // Explicit commit — Enter, or picking a suggestion. Normalises the box
        // to the chosen value, closes the list and jumps to the table.
        const commit = (value) => {
            const q = String(value ?? input.value).trim().toUpperCase();
            clearTimeout(liveTimer);
            clearTimeout(settleTimer);
            input.value = q;
            clearBtn.style.display = q ? 'flex' : 'none';
            closeList();
            lastScrolledFor = q;
            lastFullQuery = q;
            const changed = q !== assetLookupQuery;
            applyAssetQuery(q, { scroll: true });
            // Re-committing the same value (Enter twice) should still re-focus
            // the table rather than doing nothing.
            if (!changed && q) revealSearchResult();
        };

        // Rank exact match first, then prefix, then substring. Every SLRN shares
        // the "IESH" prefix, so a short query matches everything — hence the cap.
        const scan = (index, type, metaFor, q) => {
            const exact = [], prefix = [], sub = [];
            for (const id of index.keys()) {
                if (id === q) exact.push(id);
                else if (id.startsWith(q)) { if (prefix.length < 50) prefix.push(id); }
                else if (id.includes(q)) { if (sub.length < 50) sub.push(id); }
            }
            return [...exact, ...prefix.sort(), ...sub.sort()]
                .slice(0, 6)
                .map(id => ({ id, type, meta: metaFor(id) }));
        };

        const suggest = (q) => [
            ...scan(poleIndex, 'Pole', id => {
                const n = poleIndex.get(id).size;
                return n ? `${n} building${n > 1 ? 's' : ''}` : 'no buildings';
            }, q),
            ...scan(buildingIndex, 'Building', id => {
                const poles = [...buildingIndex.get(id)];
                return poles.length === 1 ? `on ${poles[0]}` : `on ${poles.length} poles`;
            }, q)
        ].slice(0, 12);

        const render = (items, q) => {
            if (!items.length) { closeList(); return; }
            list.innerHTML = '<div class="asset-lookup-header">Matching assets</div>';
            items.forEach((it, i) => {
                const div = document.createElement('div');
                div.className = 'asset-lookup-item';
                div.dataset.index = i;
                div.innerHTML = `
                    <span class="asset-lookup-id">${highlightMatch(it.id, q)}</span>
                    <span class="asset-lookup-meta">${it.meta}</span>
                    <span class="asset-lookup-badge badge-${it.type.toLowerCase()}">${it.type}</span>`;
                div.addEventListener('mousedown', e => { e.preventDefault(); commit(it.id); });
                list.appendChild(div);
            });
            list.style.display = 'flex';
        };

        input.addEventListener('input', () => {
            const q = input.value.trim().toUpperCase();
            clearBtn.style.display = q ? 'flex' : 'none';
            clearTimeout(liveTimer);
            clearTimeout(settleTimer);

            // Filter as you type / paste — table only, so it stays responsive.
            liveTimer = setTimeout(() => {
                if (q.length >= 3) render(suggest(q), q);
                else closeList();
                applyAssetQuery(q.length >= MIN_LIVE_CHARS ? q : '', { light: true });
            }, 200);

            // Typing stopped: catch the rest of the dashboard up (charts, map,
            // KPIs, slicer cascade), then take them to the table. Deferred so
            // the page doesn't lurch — and the filter bar is not sticky, so
            // scrolling mid-keystroke would pull this input off-screen.
            settleTimer = setTimeout(() => {
                if (lastFullQuery !== assetLookupQuery) {
                    lastFullQuery = assetLookupQuery;
                    cascadeAssetLookupOptions();
                    applyFilters();
                }
                if (!assetLookupQuery || !autoExpandActive) return;
                if (lastScrolledFor === assetLookupQuery) return;
                lastScrolledFor = assetLookupQuery;
                revealSearchResult();
            }, 850);
        });

        input.addEventListener('keydown', e => {
            const items = list.querySelectorAll('.asset-lookup-item');
            if (e.key === 'Enter') {
                e.preventDefault();
                const picked = focusIndex >= 0 && items[focusIndex]
                    ? items[focusIndex].querySelector('.asset-lookup-id').textContent
                    : undefined;
                commit(picked);
                return;
            }
            if (e.key === 'Escape') { closeList(); return; }
            if (!items.length || list.style.display === 'none') return;
            if (e.key === 'ArrowDown') { e.preventDefault(); focusIndex = Math.min(focusIndex + 1, items.length - 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); focusIndex = Math.max(focusIndex - 1, 0); }
            else return;
            items.forEach((el, i) => el.classList.toggle('active', i === focusIndex));
            items[focusIndex]?.scrollIntoView({ block: 'nearest' });
        });

        input.addEventListener('blur', () => setTimeout(closeList, 120));
        clearBtn.addEventListener('click', () => { commit(''); input.focus(); });
        clearBtn.style.display = 'none';
    }

    // Push a SLRN into the lookup box and apply it — used by the building chips
    // in the DT drill-down so a chip click becomes a filter.
    function applyAssetLookup(slrn) {
        const input = document.getElementById('assetLookupInput');
        const clearBtn = document.getElementById('assetLookupClear');
        const q = String(slrn || '').trim().toUpperCase();
        if (input) { input.value = q; input.classList.toggle('has-value', !!q); }
        if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
        assetLookupQuery = q;
        currentPage = 1;
        collapsedDTKeys.clear();
        cascadeAssetLookupOptions();
        applyFilters();
        if (q) revealSearchResult();
    }

    // Bring the (now auto-expanded) Pole Register into view after a lookup.
    // Deferred briefly because applyFilters() redraws the charts and map above
    // the table, so scrolling synchronously would target a stale offset. Uses a
    // timer rather than requestAnimationFrame, which never fires in a
    // background/unrendered tab and would silently skip the scroll.
    // Bring the search result into view: the map, framed on the pole. The Pole
    // Register still auto-expands below — the user scrolls down to it — but the
    // map is what a SLRN search is really asking to see.
    function revealSearchResult() {
        const TARGET_ID = 'map-section';
        const jump = (behavior) => {
            const target = document.getElementById(TARGET_ID);
            // The dashboard view must be showing — on the executive-summary
            // view this has no layout box and scrolling to it is a no-op.
            if (!target || !target.getClientRects().length) return;
            target.scrollIntoView({ behavior, block: 'start' });
        };

        // First pass, once the re-render has landed.
        setTimeout(() => jump('smooth'), 60);
        // Plotly charts above the map finish drawing later and shift the page
        // under us, so the first jump lands short. Correct once they settle,
        // but only if we actually drifted.
        setTimeout(() => {
            const target = document.getElementById(TARGET_ID);
            if (!target || !target.getClientRects().length) return;
            if (Math.abs(target.getBoundingClientRect().top) > 80) jump('auto');
        }, 700);
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
        // #downloadPDF is now a dropdown menu item (icon + text spans), so update
        // only the label text — never textContent, which would wipe the icon.
        const setPdfBtnLabel = (text) => {
            const strong = downloadPdfBtn.querySelector('.tdi-text strong');
            if (strong) strong.textContent = text;
            else downloadPdfBtn.textContent = text;
        };
        downloadPdfBtn.addEventListener('click', () => {
            if (!filteredData || filteredData.length === 0) {
                alert('No data available to generate PDF. Please load data first.');
                return;
            }
            setPdfBtnLabel('Generating PDF...');
            downloadPdfBtn.style.opacity = '0.7';
            downloadPdfBtn.style.pointerEvents = 'none';

            try {
                // Access jsPDF from html2pdf bundle
                const { jsPDF } = window.jspdf || {};
                if (!jsPDF) { alert('PDF library not loaded. Please refresh.'); setPdfBtnLabel('Download PDF Report'); downloadPdfBtn.style.opacity = '1'; downloadPdfBtn.style.pointerEvents = 'auto'; return; }
                const doc = new jsPDF('p', 'mm', 'a4');
                doc.setProperties({
                    title: 'IDB 2.0 Assets Tagging — Management Report',
                    subject: 'Asset Enumeration Programme',
                    author: 'IDB 2.0 Monitoring System',
                    creator: 'IDB 2.0 Dashboard (Ikeja Electric)'
                });
                const pw = 210, ph = 297, ml = 14, mr = 14, mt = 16;
                const cw = pw - ml - mr;
                let y = mt;

                // One analytics engine feeds the PDF and the Excel workbook, so
                // every figure here matches the workbook and the on-screen KPIs.
                const stats = computeReportStats();
                const { dateStr, timeStr } = stats.generatedAt;
                const filterText = stats.filterText;

                // ── palette ──────────────────────────────────────────────────
                const setColor = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
                const BLUE = setColor('#1e40af'), INK = setColor('#1f2937'), SLATE = setColor('#475569'), MUTE = setColor('#94a3b8');
                const vendorColor = (name) => name === 'ETC Workforce' ? setColor('#0ea5e9') : name === 'Jesom Technology' ? setColor('#ef4444') : name === 'Ikeja Electric' ? setColor('#eab308') : setColor('#64748b');
                const PALETTE = ['#0ea5e9', '#b45309', '#10b981', '#8b5cf6', '#64748b', '#ec4899', '#f59e0b'].map(setColor);
                const STATUS_COLORS = { 'Completed': setColor('#059669'), 'Near Complete': setColor('#f59e0b'), 'In Progress': setColor('#3b82f6'), 'Not Started': setColor('#94a3b8') };

                // ── page/running-header plumbing ─────────────────────────────
                let currentSection = '';
                const slimHeader = (label) => {
                    doc.setFillColor(...BLUE);
                    doc.rect(0, 0, pw, 11, 'F');
                    doc.setTextColor(255, 255, 255); doc.setFontSize(9); doc.setFont('helvetica', 'bold');
                    doc.text('IDB 2.0 ASSETS TAGGING MONITORING REPORT', ml, 7);
                    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
                    doc.text(label || '', pw - mr, 7, { align: 'right' });
                    y = 17;
                };
                const checkPage = (need) => { if (y + need > ph - 14) { doc.addPage(); slimHeader(currentSection); } };
                const newPage = (section) => { doc.addPage(); currentSection = section; slimHeader(section); };

                const wrapText = (text, maxWidth, fontSize) => {
                    doc.setFontSize(fontSize);
                    const words = String(text).split(' ');
                    const lines = []; let line = '';
                    words.forEach(w => {
                        const test = line ? line + ' ' + w : w;
                        if (doc.getTextWidth(test) > maxWidth) { if (line) lines.push(line); line = w; }
                        else line = test;
                    });
                    if (line) lines.push(line);
                    return lines;
                };
                const sectionTitle = (t) => {
                    checkPage(12);
                    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...BLUE);
                    doc.text(t, ml, y); y += 1.6;
                    doc.setDrawColor(...BLUE); doc.setLineWidth(0.4); doc.line(ml, y, ml + cw, y); y += 5;
                    doc.setLineWidth(0.2);
                };
                const writeParagraph = (text, opts = {}) => {
                    const lines = wrapText(text, cw - 4, opts.size || 8.5);
                    doc.setFontSize(opts.size || 8.5); doc.setFont('helvetica', opts.font || 'normal');
                    doc.setTextColor(...(opts.color || SLATE));
                    lines.forEach(line => { checkPage(4.6); doc.text(line, ml + 1, y); y += 4.2; });
                    y += 2;
                };

                // ── chart primitives (pure vector — print-crisp, theme-free) ──
                const drawDonut = (cx, cy, rO, rI, segs, centerTop, centerBot) => {
                    const total = segs.reduce((s, x) => s + x.value, 0) || 1;
                    let a = -Math.PI / 2;
                    segs.forEach(seg => {
                        if (seg.value <= 0) return;
                        const end = a + (seg.value / total) * 2 * Math.PI;
                        const steps = Math.max(2, Math.ceil((end - a) / (Math.PI / 36)));
                        doc.setFillColor(...seg.rgb);
                        for (let i = 0; i < steps; i++) {
                            const a0 = a + (end - a) * i / steps, a1 = a + (end - a) * (i + 1) / steps;
                            doc.triangle(cx, cy, cx + rO * Math.cos(a0), cy + rO * Math.sin(a0), cx + rO * Math.cos(a1), cy + rO * Math.sin(a1), 'F');
                        }
                        a = end;
                    });
                    doc.setFillColor(255, 255, 255); doc.circle(cx, cy, rI, 'F');
                    if (centerTop != null) {
                        doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK);
                        doc.text(String(centerTop), cx, cy + (centerBot ? 0 : 1.5), { align: 'center' });
                    }
                    if (centerBot != null) {
                        doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                        doc.text(String(centerBot), cx, cy + 4.5, { align: 'center' });
                    }
                };
                const drawLegend = (x, y0, items, width) => {
                    items.forEach((it, i) => {
                        const ly = y0 + i * 5.6;
                        doc.setFillColor(...it.rgb); doc.roundedRect(x, ly - 2.8, 3.2, 3.2, 0.5, 0.5, 'F');
                        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK);
                        doc.text(String(it.label).substring(0, 22), x + 5, ly);
                        doc.setFont('helvetica', 'bold');
                        doc.text(it.right, x + width, ly, { align: 'right' });
                    });
                };
                const drawHBars = (x, y0, w, items, opts = {}) => {
                    const max = Math.max(...items.map(i => i.value), 1);
                    const barH = opts.barH || 5.5, gap = opts.gap || 3, labelW = opts.labelW || 42, valW = 14;
                    items.forEach((it, i) => {
                        const by = y0 + i * (barH + gap);
                        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLATE);
                        doc.text(String(it.label).substring(0, 24), x, by + barH - 1.4);
                        const tx = x + labelW, tw = w - labelW - valW;
                        doc.setFillColor(...setColor('#eef2f7')); doc.roundedRect(tx, by, tw, barH, 0.6, 0.6, 'F');
                        const bw = Math.max(0.6, tw * (it.value / max));
                        doc.setFillColor(...it.rgb); doc.roundedRect(tx, by, bw, barH, 0.6, 0.6, 'F');
                        doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); doc.setFontSize(7.5);
                        doc.text(it.valueLabel != null ? String(it.valueLabel) : String(it.value), x + w, by + barH - 1.4, { align: 'right' });
                    });
                    return y0 + items.length * (barH + gap);
                };
                const drawLineChart = (x, y0, w, h, points, opts = {}) => {
                    const max = Math.max(...points.map(p => p.value), opts.target || 0, 1);
                    doc.setDrawColor(...setColor('#cbd5e1')); doc.setLineWidth(0.2);
                    doc.line(x, y0, x, y0 + h); doc.line(x, y0 + h, x + w, y0 + h);
                    [0, 0.5, 1].forEach(f => {
                        const gy = y0 + h - h * f;
                        doc.setDrawColor(...setColor('#eef2f7')); doc.line(x, gy, x + w, gy);
                        doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                        doc.text(String(Math.round(max * f)), x - 1.5, gy + 1, { align: 'right' });
                    });
                    if (opts.target) {
                        const ty = y0 + h - h * (opts.target / max);
                        doc.setDrawColor(...setColor('#ef4444')); doc.setLineWidth(0.3); doc.setLineDashPattern([1, 1], 0);
                        doc.line(x, ty, x + w, ty); doc.setLineDashPattern([], 0);
                        doc.setFontSize(6); doc.setTextColor(...setColor('#ef4444'));
                        doc.text(`Target ${opts.target}`, x + w, ty - 1, { align: 'right' });
                    }
                    const n = points.length;
                    const px = (i) => n > 1 ? x + w * i / (n - 1) : x + w / 2;
                    const py = (v) => y0 + h - h * (v / max);
                    doc.setDrawColor(...BLUE); doc.setLineWidth(0.6);
                    for (let i = 0; i < n - 1; i++) doc.line(px(i), py(points[i].value), px(i + 1), py(points[i + 1].value));
                    const stepLbl = Math.max(1, Math.ceil(n / 8));
                    points.forEach((p, i) => {
                        doc.setFillColor(...BLUE); doc.circle(px(i), py(p.value), 0.8, 'F');
                        if (n <= 10 || i % stepLbl === 0 || i === n - 1) {
                            doc.setFontSize(5.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                            doc.text(p.label, px(i), y0 + h + 3, { align: 'center' });
                        }
                    });
                };
                const drawProgress = (x, y0, w, h, pct) => {
                    doc.setFillColor(...setColor('#e2e8f0')); doc.roundedRect(x, y0, w, h, 1, 1, 'F');
                    const col = pct >= 90 ? setColor('#059669') : pct >= 60 ? setColor('#3b82f6') : setColor('#d97706');
                    doc.setFillColor(...col); doc.roundedRect(x, y0, Math.max(1.2, w * Math.min(pct, 100) / 100), h, 1, 1, 'F');
                };

                // ── general table (per-column alignment + status colouring) ──
                const drawTable = (headers, rows, colWidths, opts = {}) => {
                    const fs = opts.fontSize || 8, rh = opts.rowHeight || 6;
                    const align = opts.align || headers.map(() => 'left');
                    const statusCol = opts.statusCol;
                    // The blue column-header band, re-drawn on every page break so
                    // continuation pages of long tables keep their column labels.
                    const drawHead = () => {
                        doc.setFontSize(fs);
                        doc.setFillColor(...BLUE); doc.rect(ml, y, cw, rh + 2, 'F');
                        doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
                        let hx = ml + 1;
                        headers.forEach((h, i) => {
                            const a = align[i] || 'left';
                            const tx = a === 'right' ? hx + colWidths[i] - 2 : hx + 1.5;
                            doc.text(String(h), tx, y + rh - 0.5, { align: a === 'right' ? 'right' : 'left' });
                            hx += colWidths[i];
                        });
                        y += rh + 2;
                        doc.setFont('helvetica', 'normal');
                    };
                    doc.setFontSize(fs);
                    checkPage(rh * 3);
                    drawHead();
                    let cx = ml + 1;
                    rows.forEach((row, ri) => {
                        if (y + rh + 1 > ph - 14) { doc.addPage(); slimHeader(currentSection); drawHead(); }
                        if (ri % 2 === 1) { doc.setFillColor(...setColor('#f4f7fb')); doc.rect(ml, y, cw, rh + 1, 'F'); }
                        cx = ml + 1;
                        row.forEach((cell, ci) => {
                            const a = align[ci] || 'left';
                            let txt = String(cell);
                            const maxChars = Math.floor(colWidths[ci] / (fs * 0.19));
                            if (txt.length > maxChars) txt = txt.substring(0, Math.max(1, maxChars - 1)) + '…';
                            if (statusCol === ci && STATUS_COLORS[cell]) doc.setTextColor(...STATUS_COLORS[cell]), doc.setFont('helvetica', 'bold');
                            else doc.setTextColor(...INK), doc.setFont('helvetica', 'normal');
                            const tx = a === 'right' ? cx + colWidths[ci] - 2 : cx + 1.5;
                            doc.text(txt, tx, y + rh - 0.5, { align: a === 'right' ? 'right' : 'left' });
                            cx += colWidths[ci];
                        });
                        doc.setDrawColor(...setColor('#e5e7eb')); cx = ml;
                        colWidths.forEach(w => { doc.line(cx, y, cx, y + rh + 1); cx += w; });
                        doc.line(cx, y, cx, y + rh + 1);
                        doc.line(ml, y + rh + 1, ml + cw, y + rh + 1);
                        y += rh + 1;
                    });
                    y += 3;
                };

                // ═══════════════════ PAGE 1 — COVER & EXECUTIVE SUMMARY ═══════
                currentSection = 'Executive Summary';
                doc.setFillColor(...BLUE); doc.rect(0, 0, pw, 24, 'F');
                doc.setFillColor(...setColor('#1e3a8a')); doc.rect(0, 24, pw, 1.4, 'F');
                doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont('helvetica', 'bold');
                doc.text('IDB 2.0 ASSETS TAGGING MONITORING REPORT', pw / 2, 11, { align: 'center' });
                doc.setFontSize(9); doc.setFont('helvetica', 'normal');
                doc.text(`Ikeja Electric  ·  Asset Enumeration Programme`, pw / 2, 17, { align: 'center' });
                doc.setFontSize(7.5);
                doc.text(`Generated ${dateStr} at ${timeStr}   |   Scope: ${filterText}`.substring(0, 130), pw / 2, 21.5, { align: 'center' });
                y = 32;

                // Hero KPI cards
                const heroCards = (cards) => {
                    const n = cards.length, gap = 3, cwid = (cw - (n - 1) * gap) / n, ch = 21;
                    cards.forEach((c, i) => {
                        const bx = ml + i * (cwid + gap);
                        doc.setFillColor(...c.bg); doc.roundedRect(bx, y, cwid, ch, 1.5, 1.5, 'F');
                        doc.setDrawColor(...c.accent); doc.setLineWidth(0.5); doc.line(bx, y, bx, y + ch);
                        doc.setFontSize(6.8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLATE);
                        doc.text(c.title.toUpperCase(), bx + 4, y + 5.5);
                        doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(...c.accent);
                        doc.text(String(c.value), bx + 4, y + 13.5);
                        doc.setFontSize(6.3); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                        doc.text(String(c.sub || ''), bx + 4, y + 18.5);
                    });
                    y += ch + 5;
                };
                heroCards([
                    { title: 'Unique Poles', value: stats.totalUnique.toLocaleString(), sub: `${stats.rawCount.toLocaleString()} captures`, bg: setColor('#eff6ff'), accent: BLUE },
                    { title: 'BOQ Completion', value: stats.boq.completionPct != null ? stats.boq.completionPct.toFixed(1) + '%' : '—', sub: stats.boq.target ? `of ${stats.boq.target.toLocaleString()} target` : 'no target in scope', bg: setColor('#f0fdf4'), accent: setColor('#059669') },
                    { title: 'Building Linkage', value: stats.linkage.pct.toFixed(1) + '%', sub: `${stats.linkage.unlinked.toLocaleString()} to tag`, bg: setColor('#fffbeb'), accent: setColor('#b45309') },
                    { title: 'Run Rate', value: Math.round(stats.velocity.runRate) + '/day', sub: stats.velocity.verdict, bg: setColor('#ecfeff'), accent: setColor('#0891b2') }
                ]);

                sectionTitle('EXECUTIVE SUMMARY');
                writeParagraph(`The IDB 2.0 Asset Enumeration programme has captured ${stats.totalUnique.toLocaleString()} unique pole assets across ${stats.coverage.bus} business unit${stats.coverage.bus > 1 ? 's' : ''}, ${stats.coverage.feeders} feeders, ${stats.coverage.dts} distribution transformers and ${stats.coverage.uts} undertaking${stats.coverage.uts > 1 ? 's' : ''}. A workforce of ${stats.coverage.officers} field officers is active across the vendor teams, with data collection spanning ${stats.velocity.firstDate} to ${stats.velocity.lastDate} (${stats.velocity.activeDays} active working days).`);
                writeParagraph(`Delivery velocity is ${Math.round(stats.velocity.runRate)} poles/day, ${stats.velocity.verdict} against the ${stats.velocity.targetRate} poles/day benchmark. The recent 3-day trend is ${stats.velocity.trending}${stats.velocity.trendPct ? ` (${stats.velocity.trendPct > 0 ? '+' : ''}${stats.velocity.trendPct}% vs the prior period)` : ''}.${stats.boq.completionPct != null ? ` Overall BOQ completion stands at ${stats.boq.completionPct.toFixed(1)}% (${stats.totalUnique.toLocaleString()} of ${stats.boq.target.toLocaleString()} target poles).` : ''}`);
                writeParagraph(`Of ${stats.linkage.total.toLocaleString()} poles captured, ${stats.linkage.pct.toFixed(1)}% (${stats.linkage.linked.toLocaleString()}) carry an associated building SLRN while ${stats.linkage.unlinked.toLocaleString()} remain unlinked; ${stats.buildings.toLocaleString()} buildings are connected across the network.${stats.dominantPole ? ` ${stats.dominantPole.type} is the dominant pole type at ${stats.dominantPole.pct.toFixed(0)}% of assets.` : ''} ${stats.linkage.pct < 60 ? 'Building-tagging completeness is low; prioritise linking the outstanding poles.' : stats.linkage.pct < 85 ? 'Building-tagging is progressing; schedule follow-up on unlinked poles.' : 'Building-SLRN linkage is strong across the captured assets.'}`);
                const vendorSentence = stats.vendors.map(v => `${v.name} ${v.count.toLocaleString()} (${v.pct.toFixed(1)}%)`).join(', ');
                writeParagraph(`Vendor contribution: ${vendorSentence}.${stats.vendors.length > 1 ? ` ${stats.vendors[0].name} leads the enumeration effort.` : ''}`);
                writeParagraph(`DT delivery across ${stats.dtStats.total} tracked transformers: ${stats.dtStats.completed} completed, ${stats.dtStats.nearComplete} near completion, ${stats.dtStats.inProgress} in progress and ${stats.dtStats.notStarted} not yet started.${stats.dtStats.notStarted > 0 ? ` The ${stats.dtStats.notStarted} unstarted DTs should be prioritised in the next cycle.` : ' All tracked DTs have commenced.'}`);

                // Recommendations box
                checkPage(10);
                doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...setColor('#92400e'));
                doc.text('KEY RECOMMENDATIONS', ml, y); y += 4.5;
                doc.setFont('helvetica', 'normal'); doc.setTextColor(...setColor('#78350f'));
                const recs = [];
                if (stats.velocity.runRate < stats.velocity.targetRate) recs.push(`Lift the daily run rate from ${Math.round(stats.velocity.runRate)} toward the ${stats.velocity.targetRate} poles/day target.`);
                else recs.push(`Sustain the current run rate of ${Math.round(stats.velocity.runRate)} poles/day, which meets the project target.`);
                if (stats.linkage.pct < 85 && stats.linkage.unlinked > 0) recs.push(`Improve building-SLRN linkage (currently ${stats.linkage.pct.toFixed(1)}%) by tagging the ${stats.linkage.unlinked.toLocaleString()} unlinked poles.`);
                if (stats.dtStats.notStarted > 0) recs.push(`Mobilise resources for the ${stats.dtStats.notStarted} unstarted DTs to prevent timeline slippage.`);
                if (stats.vendors.length > 1) { const lag = stats.vendors[stats.vendors.length - 1]; recs.push(`Review capacity for ${lag.name} (${lag.pct.toFixed(1)}% share) to balance vendor throughput.`); }
                recs.push('Continue daily monitoring and hold weekly vendor review meetings.');
                recs.forEach(r => { wrapText('•  ' + r, cw - 6, 8).forEach(l => { checkPage(4); doc.setFontSize(8); doc.text(l, ml + 3, y); y += 3.9; }); });

                // Notes & methodology footnote — states the counting basis.
                y += 2; checkPage(14);
                doc.setDrawColor(...setColor('#e5e7eb')); doc.setLineWidth(0.2); doc.line(ml, y, ml + cw, y); y += 3.5;
                doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLATE);
                doc.text('NOTES & METHODOLOGY', ml, y); y += 3.4;
                doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                methodologyLines().forEach(n => { wrapText('•  ' + n, cw - 4, 6.5).forEach(l => { checkPage(3.2); doc.setFontSize(6.5); doc.text(l, ml + 2, y); y += 2.9; }); });

                // ═══════════════════ PAGE 2 — VISUAL ANALYTICS ════════════════
                newPage('Visual Analytics');
                sectionTitle('VISUAL ANALYTICS');

                // Row A: two donuts (vendor share, pole type)
                const donutTop = y + 2;
                const dcx1 = ml + 26, dcx2 = ml + cw / 2 + 26;
                doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK);
                doc.text('Vendor Share', ml, y); doc.text('Pole Type Mix', ml + cw / 2, y);
                const vendSegs = stats.vendors.map(v => ({ value: v.count, rgb: vendorColor(v.name) }));
                drawDonut(dcx1, donutTop + 20, 18, 10.5, vendSegs, stats.totalUnique.toLocaleString(), 'poles');
                drawLegend(dcx1 + 24, donutTop + 12, stats.vendors.map(v => ({ label: v.name, rgb: vendorColor(v.name), right: `${v.pct.toFixed(1)}%` })), cw / 2 - 52);
                const typeSegs = stats.poleTypes.slice(0, 6).map((t, i) => ({ value: t.count, rgb: PALETTE[i % PALETTE.length] }));
                drawDonut(dcx2, donutTop + 20, 18, 10.5, typeSegs, stats.dominantPole ? stats.dominantPole.pct.toFixed(0) + '%' : '', stats.dominantPole ? stats.dominantPole.type : '');
                drawLegend(dcx2 + 24, donutTop + 12, stats.poleTypes.slice(0, 6).map((t, i) => ({ label: t.type, rgb: PALETTE[i % PALETTE.length], right: `${t.pct.toFixed(1)}%` })), cw / 2 - 52);
                y = donutTop + 46;

                // Row B: DT status horizontal bars + BOQ completion gauge
                checkPage(50);
                doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK);
                doc.text('DT Delivery Status', ml, y);
                doc.text('BOQ Completion', ml + cw / 2, y);
                const statusItems = [
                    { label: 'Completed', value: stats.dtStats.completed, rgb: STATUS_COLORS['Completed'] },
                    { label: 'Near Complete', value: stats.dtStats.nearComplete, rgb: STATUS_COLORS['Near Complete'] },
                    { label: 'In Progress', value: stats.dtStats.inProgress, rgb: STATUS_COLORS['In Progress'] },
                    { label: 'Not Started', value: stats.dtStats.notStarted, rgb: STATUS_COLORS['Not Started'] }
                ];
                drawHBars(ml, y + 4, cw / 2 - 10, statusItems, { labelW: 26 });
                // completion gauge on the right
                const gx = ml + cw / 2, gw = cw / 2;
                const cpct = stats.boq.completionPct != null ? stats.boq.completionPct : 0;
                doc.setFontSize(20); doc.setFont('helvetica', 'bold'); doc.setTextColor(...BLUE);
                doc.text(stats.boq.completionPct != null ? cpct.toFixed(1) + '%' : 'N/A', gx, y + 14);
                doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                doc.text(stats.boq.target ? `${stats.totalUnique.toLocaleString()} of ${stats.boq.target.toLocaleString()} target poles` : 'No BOQ target in current scope', gx, y + 19);
                drawProgress(gx, y + 23, gw, 6, cpct);
                y += 40;

                // Row C: velocity line chart (last 14 active days)
                checkPage(50);
                doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK);
                doc.text('Daily Capture Velocity (last 14 active days)', ml, y); y += 4;
                const vpts = stats.velocity.dailyCounts.slice(-14).map(d => ({ label: d.date.slice(0, 5), value: d.count }));
                if (vpts.length >= 2) drawLineChart(ml + 6, y, cw - 8, 34, vpts, { target: stats.velocity.targetRate });
                else { doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(...MUTE); doc.text('Not enough dated captures to plot a trend.', ml + 6, y + 10); }
                y += 42;

                // ═══════════════════ PAGE 3 — PERFORMANCE TABLES ═════════════
                newPage('Performance Tables');
                sectionTitle('KEY PERFORMANCE INDICATORS');
                drawTable(['Metric', 'Expected', 'Actual', 'Progress', 'Remaining'],
                    stats.kpiCards,
                    [cw * 0.30, cw * 0.17, cw * 0.17, cw * 0.18, cw * 0.18],
                    { align: ['left', 'right', 'right', 'right', 'right'] });

                sectionTitle('VENDOR PERFORMANCE BREAKDOWN');
                const vRows = stats.vendors.map(v => [v.name, v.count.toLocaleString(), v.pct.toFixed(1) + '%']);
                vRows.push(['TOTAL', stats.totalUnique.toLocaleString(), '100%']);
                drawTable(['Vendor', 'Assets Tagged', 'Share'], vRows,
                    [cw * 0.5, cw * 0.28, cw * 0.22], { align: ['left', 'right', 'right'] });

                sectionTitle('TOP FIELD OFFICERS (BY UNIQUE POLES)');
                const oRows = stats.officers.slice(0, 20).map((o, i) => [String(i + 1), o.name, o.count.toLocaleString(), o.pct.toFixed(1) + '%']);
                drawTable(['#', 'Field Officer', 'Assets', 'Share'], oRows,
                    [cw * 0.08, cw * 0.52, cw * 0.22, cw * 0.18], { align: ['left', 'left', 'right', 'right'] });

                // ═══════════════════ PAGE 4+ — DT PERFORMANCE ════════════════
                newPage('DT Performance');
                const dtShown = stats.dtRows.slice(0, 45);
                sectionTitle(`DT PERFORMANCE ANALYSIS${dtShown.length < stats.dtRows.length ? ` (Top ${dtShown.length} of ${stats.dtRows.length})` : ''}`);
                const dRows = dtShown.map((r, i) => {
                    const c = dtClassify(r);
                    const progLabel = c.progress == null ? '—' : c.progress.toFixed(1) + '%';
                    return [String(i + 1), r.dtName, r.feeder, r.vendor, String(r.boqTotal), String(r.actualTotal), String(r.concrete), String(r.wooden), progLabel, c.status];
                });
                drawTable(['#', 'DT Name', 'Feeder', 'Vendor', 'Exp.', 'Act.', 'Conc.', 'Wood', 'Prog.', 'Status'], dRows,
                    [cw * 0.04, cw * 0.19, cw * 0.15, cw * 0.11, cw * 0.06, cw * 0.06, cw * 0.06, cw * 0.06, cw * 0.07, cw * 0.14],
                    { fontSize: 6.5, rowHeight: 5, align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'], statusCol: 9 });

                // ═══════════════════ FOOTER (all pages) ══════════════════════
                const totalPgs = doc.internal.getNumberOfPages();
                for (let p = 1; p <= totalPgs; p++) {
                    doc.setPage(p);
                    doc.setDrawColor(...setColor('#e5e7eb')); doc.setLineWidth(0.2); doc.line(ml, ph - 9, pw - mr, ph - 9);
                    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE);
                    doc.text('IDB 2.0 Monitoring System  ·  Ikeja Electric', ml, ph - 5);
                    doc.text(`Page ${p} of ${totalPgs}`, pw / 2, ph - 5, { align: 'center' });
                    doc.text(`Generated ${dateStr}`, pw - mr, ph - 5, { align: 'right' });
                }

                doc.save(`IDB_Assets_Report_${new Date().toISOString().split('T')[0]}.pdf`);
                setPdfBtnLabel('Download PDF Report');
                downloadPdfBtn.style.opacity = '1';
                downloadPdfBtn.style.pointerEvents = 'auto';

            } catch (err) {
                console.error('PDF Build Error:', err);
                alert('Failed to build PDF report: ' + err.message);
                setPdfBtnLabel('Download PDF Report');
                downloadPdfBtn.style.opacity = '1';
                downloadPdfBtn.style.pointerEvents = 'auto';
            }
        });
    }

}); // End DOMContentLoaded
