// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {connect} from 'react-redux';


import PremadeThemeChooser from './premade_theme_chooser';

function mapStateToProps() {
    // Lock to Denim theme only for this customization.
    return {
        allowedThemes: ['denim'],
    };
}

export default connect(mapStateToProps)(PremadeThemeChooser);
